// Risk rules for agent activity.
//
// Each rule looks at one piece of text an agent produced or received (a tool
// call's arguments, a tool's result, the newest user prompt) and returns
// matches. Rules are heuristics and say so: they catch the common shapes of
// dangerous actions and leaked secrets, and a determined agent can phrase
// around any of them. Their job is to put the right events in front of a
// reviewer, and the log keeps everything regardless of what they match.
//
// Every rule carries the controls it gives evidence for, so an exported
// finding already says which ISO 27001, ISO 42001 or SOC 2 requirement it
// supports.
//
// Modes, set per rule:
//   observe  the finding is recorded on the event, nothing else
//   flag     the event also enters the review queue
//   ask      flag, and where the action has not run yet, make a person
//            approve it (a Claude Code permission prompt)
//   block    flag, and where the action has not run yet, refuse it
//
// "Where the action has not run yet" is the point. Enforcement happens only at
// capture points that see an action before it executes: a Claude Code
// PreToolUse hook, and a tool call through the MCP proxy. On the model
// connection the tool call has already reached the agent (on a stream, before
// it is even complete), so there ask and block are recorded exactly like flag,
// and the event says it was not enforceable. A block that silently fails to
// block would be worse than a flag that says what it is.

import { redactPii, detectInjection } from "../security/guardrails.js";

export const MODES = ["observe", "flag", "ask", "block"];
const ENFORCING = new Set(["ask", "block"]);

/** The decision a set of findings demands at an enforcing capture point. */
export function decide(findings) {
  const blocking = findings.filter((f) => f.mode === "block");
  if (blocking.length) return { decision: "block", because: blocking };
  const asking = findings.filter((f) => f.mode === "ask");
  if (asking.length) return { decision: "ask", because: asking };
  return { decision: null, because: [] };
}

export function isEnforcing(mode) {
  return ENFORCING.has(mode);
}
export const SEVERITIES = ["low", "medium", "high", "critical"];

// Patterns are bounded and anchored on word boundaries so a hostile tool
// result cannot make the scan quadratic. Input is capped before it arrives.
const DESTRUCTIVE = [
  /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+){1,3}(?:\/|~|\*|\.\.?(?:\s|$)|\$HOME)/,
  /\bmkfs(?:\.[a-z0-9]+)?\s/,
  /\bdd\s+[^\n]{0,80}\bof=\/dev\//,
  /\bformat(?:\.com)?\s+[a-z]:/i,
  /\b(?:del|erase)\s+[^\n]{0,40}\/[sq]\b/i,
  /\brd\s+\/s\b|\brmdir\s+\/s\b/i,
  /\bRemove-Item\b[^\n]{0,120}-Recurse\b[^\n]{0,60}-Force\b|\bRemove-Item\b[^\n]{0,120}-Force\b[^\n]{0,60}-Recurse\b/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // fork bomb
  /\bchmod\s+-R\s+0?777\s+\//,
  /\bgit\s+push\b[^\n]{0,80}(?:--force\b|\s-f\b)/,
  /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f[a-z]*d)\b/,
  /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i,
  /\bDELETE\s+FROM\s+\w+\s*(?:;|$)/i, // DELETE with no WHERE
  /\b(?:shutdown|reboot|halt)\b(?:\s+(?:-[a-z]+|\/[a-z]+|now))/i
];

const REMOTE_EXEC = [
  /\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/,
  /\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]{0,200}\|\s*(?:iex|Invoke-Expression)\b/i,
  /\b(?:iex|Invoke-Expression)\s*\(?\s*\(?\s*(?:New-Object\s+Net\.WebClient|iwr|irm)\b/i,
  /\bpython[0-9.]*\s+-c\s+["'][^\n]{0,200}(?:urlopen|requests\.get)[^\n]{0,200}exec\(/,
  /\bbase64\s+(?:-d|--decode)\b[^\n|]{0,80}\|\s*(?:ba)?sh\b/
];

const PRIVILEGE = [
  /(?:^|[\s;&|])sudo\s+(?!-[lvkK]\b)/,
  /\brunas\s+\/user:/i,
  /\bStart-Process\b[^\n]{0,120}-Verb\s+RunAs\b/i,
  /\bSet-ExecutionPolicy\s+(?:Unrestricted|Bypass)\b/i,
  /\bnet\s+(?:user|localgroup)\s+[^\n]{0,60}\/add\b/i,
  /\b(?:usermod|useradd|passwd|visudo|chown\s+root)\b/,
  /\bchmod\s+[ug]?\+s\b/
];

const SENSITIVE_PATHS = [
  /(?:^|[\s"'=:/\\])\.ssh[/\\](?:id_[a-z0-9]+|authorized_keys|config)\b/i,
  /(?:^|[\s"'=:/\\])\.aws[/\\]credentials\b/i,
  /(?:^|[\s"'=:/\\])\.(?:git-credentials|netrc|npmrc|pypirc|docker[/\\]config\.json)\b/i,
  /(?:^|[\s"'=:/\\])\.env(?:\.[a-z]+)?(?=$|[\s"'])/i,
  /\/etc\/(?:shadow|sudoers|passwd)\b/,
  /\b(?:SAM|SECURITY|SYSTEM)\b[^\n]{0,20}\\config\\/i,
  /\.kube[/\\]config\b/i,
  /\.tollpike[/\\](?:\.env|data)\b/i
];

// Credential shapes beyond the guardrail set: those are reused through
// redactPii below, these add cloud and generic forms.
const SECRET_EXTRA = [
  { name: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: "slack_webhook", pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Z0-9/]{20,}/i },
  { name: "anthropic_key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "tollpike_key", pattern: /\bt(?:pk|pa)_[A-Za-z0-9_-]{24,}/ }, // operator and agent keys
  { name: "password_assignment", pattern: /\b(?:password|passwd|pwd|secret|api[_-]?key|token)\s*[=:]\s*["']?[^\s"']{8,}/i }
];

// Actions in a vendor's own audit log that change who can do what, or what
// is kept. Matched against the vendor's action name and its details. The
// boundaries are "not a letter" rather than \b: vendors spell actions in
// snake_case, and an underscore is a word character, so \b never fires
// inside admin_api_key_created.
const VENDOR_PRIVILEGED = /(?<![a-z])(?:(?:api[_.\s-]?key|admin[_.\s-]?key|service[_.\s-]?account|token)[_.\s-]?(?:created|generated|added)|(?:role|permission|owner|admin)[_.\s-]?(?:granted|assigned|added|changed|updated|promoted)|(?:sso|saml|scim|mfa|2fa|domain)[_.\s-]?(?:\w+[_.\s-]?)?(?:disabled|removed|deleted|changed|updated)|(?:audit[_.\s-]?log|retention|data[_.\s-]?sharing|training)[_.\s-]?(?:\w+[_.\s-]?)?(?:disabled|changed|updated|deleted)|(?:data|conversation|workspace)[_.\s-]?export(?:ed)?|ip[_.\s-]?allowlist[_.\s-]?(?:disabled|removed|changed|updated))(?![a-z])/i;

const SECRET_FINDINGS = new Set(["api_key", "private_key_block", "jwt"]);
const PII_FINDINGS = new Set(["email", "credit_card", "iban"]);

function anyMatch(patterns, text) {
  return patterns.some((p) => p.test(text));
}

function secretsIn(text) {
  const found = new Set(redactPii(text).found.filter((f) => SECRET_FINDINGS.has(f)));
  for (const s of SECRET_EXTRA) if (s.pattern.test(text)) found.add(s.name);
  return [...found];
}

/**
 * Each rule: id, what it looks at (`on`), severity, default mode, the
 * controls it supports, and `test(text, ctx)` returning a detail string or
 * null. `on` is any of "tool_call", "tool_result", "prompt", "model_call".
 */
export const RULES = [
  {
    id: "shell.destructive",
    title: "Destructive command",
    on: ["tool_call"],
    severity: "high",
    mode: "flag",
    controls: ["ISO27001:8.16", "SOC2:CC7.2", "ISO42001:A.9.2", "ISO42001:A.6.2.6"],
    test: (t) => (anyMatch(DESTRUCTIVE, t) ? "irreversible delete, overwrite, force-push or schema drop" : null)
  },
  {
    id: "shell.remote_exec",
    title: "Download and execute",
    on: ["tool_call"],
    severity: "critical",
    mode: "flag",
    controls: ["ISO27001:8.16", "ISO27001:8.7", "SOC2:CC7.2", "SOC2:CC6.8", "ISO42001:A.9.2", "ISO42001:A.6.2.6"],
    test: (t) => (anyMatch(REMOTE_EXEC, t) ? "code fetched from the network and executed in one step" : null)
  },
  {
    id: "privilege.escalation",
    title: "Privilege change",
    on: ["tool_call"],
    severity: "high",
    mode: "flag",
    controls: ["ISO27001:8.2", "SOC2:CC6.1", "SOC2:CC6.3", "ISO42001:A.9.4"],
    test: (t) => (anyMatch(PRIVILEGE, t) ? "elevation, account or permission change" : null)
  },
  {
    id: "path.sensitive",
    title: "Credential or system file touched",
    on: ["tool_call"],
    severity: "high",
    mode: "flag",
    controls: ["ISO27001:8.3", "ISO27001:8.12", "SOC2:CC6.1", "ISO42001:A.9.4"],
    test: (t) => (anyMatch(SENSITIVE_PATHS, t) ? "path to keys, credentials or system account data" : null)
  },
  {
    id: "secret.exposure",
    title: "Credential in agent traffic",
    on: ["tool_call", "tool_result"],
    severity: "critical",
    mode: "flag",
    controls: ["ISO27001:8.12", "ISO27001:5.17", "SOC2:CC6.1", "SOC2:C1.1", "ISO42001:A.9.2"],
    test: (t) => {
      const s = secretsIn(t);
      return s.length ? `credential shapes: ${s.join(", ")}` : null;
    }
  },
  {
    id: "secret.in_prompt",
    title: "Credential sent to a model provider",
    on: ["prompt"],
    severity: "high",
    mode: "flag",
    controls: ["ISO27001:8.12", "ISO27001:5.23", "SOC2:C1.1", "ISO42001:A.9.2", "ISO42001:A.10.3"],
    test: (t) => {
      const s = secretsIn(t);
      return s.length ? `credential shapes leaving for a third-party model: ${s.join(", ")}` : null;
    }
  },
  {
    id: "pii.in_traffic",
    title: "Personal data in agent traffic",
    on: ["prompt", "tool_call", "tool_result"],
    severity: "medium",
    mode: "observe",
    controls: ["ISO27001:5.34", "ISO27001:8.11", "SOC2:P4.1", "SOC2:C1.1", "ISO42001:A.9.2"],
    test: (t) => {
      const f = redactPii(t).found.filter((x) => PII_FINDINGS.has(x));
      return f.length ? `personal data shapes: ${f.join(", ")}` : null;
    }
  },
  {
    id: "injection.in_tool_result",
    title: "Prompt injection in a tool result",
    on: ["tool_result"],
    severity: "high",
    mode: "flag",
    controls: ["ISO27001:8.16", "SOC2:CC7.2", "ISO42001:A.6.2.6"],
    test: (t) => {
      const f = detectInjection(t);
      return f.length ? `injection patterns: ${f.join(", ")}` : null;
    }
  },
  {
    id: "network.unlisted_domain",
    title: "Network call to a domain outside the allowlist",
    on: ["tool_call"],
    severity: "medium",
    mode: "flag",
    controls: ["ISO27001:8.20", "ISO27001:8.23", "SOC2:CC6.6", "ISO42001:A.9.4"],
    test: (t, ctx) => {
      const allow = ctx?.allowedDomains || [];
      if (!allow.length) return null;
      const off = domainsIn(t).filter((d) => !allow.some((a) => d === a || d.endsWith(`.${a}`)));
      return off.length ? `outside the allowlist: ${[...new Set(off)].slice(0, 5).join(", ")}` : null;
    }
  },
  {
    id: "agent.unrestricted_mode",
    title: "Agent running with permission checks bypassed",
    on: ["tool_call"],
    severity: "medium",
    mode: "observe",
    controls: ["ISO27001:8.2", "ISO27001:8.18", "SOC2:CC6.1", "ISO42001:A.9.2", "ISO42001:A.9.4"],
    test: (_t, ctx) => (ctx?.permissionMode === "bypassPermissions" ? "the agent's own permission prompts are switched off" : null)
  },
  {
    id: "endpoint.unexplained_agent_activity",
    title: "Agent process no audited action explains",
    on: ["endpoint"],
    severity: "high",
    mode: "flag",
    controls: ["ISO27001:8.16", "ISO27001:8.15", "SOC2:CC7.2", "SOC2:CC7.3", "ISO42001:A.6.2.6", "ISO42001:A.6.2.8"],
    test: (_t, ctx) => (ctx?.unexplained ? "a process in an agent's tree that no recorded tool call accounts for: unreported activity, or hooks not wired" : null)
  },
  {
    id: "endpoint.direct_provider_access",
    title: "Model provider reached around the gateway",
    on: ["endpoint"],
    severity: "high",
    mode: "flag",
    controls: ["ISO27001:8.20", "ISO27001:5.23", "SOC2:CC6.6", "ISO42001:A.9.4", "ISO42001:A.10.3"],
    test: (_t, ctx) => (ctx?.providerHost ? `connection to ${ctx.providerHost}, a model provider, from outside the gateway` : null)
  },
  {
    id: "vendor.privileged_change",
    title: "Privileged change in a hosted AI service",
    on: ["vendor"],
    severity: "high",
    mode: "flag",
    controls: ["ISO27001:8.2", "ISO27001:5.18", "ISO27001:8.32", "SOC2:CC6.2", "SOC2:CC6.3", "SOC2:CC8.1", "ISO42001:A.10.3", "ISO42001:A.6.2.6"],
    test: (t) => {
      const m = String(t).match(VENDOR_PRIVILEGED);
      return m ? `vendor action looks privileged: ${m[0]}` : null;
    }
  },
  {
    id: "identity.unattributed",
    title: "Model call with no agent identity",
    on: ["model_call"],
    severity: "medium",
    mode: "observe",
    controls: ["ISO27001:5.16", "ISO27001:8.15", "SOC2:CC6.1", "ISO42001:A.6.2.8", "ISO42001:A.3.2"],
    test: (_t, ctx) => (ctx?.anonymous ? "no agent key: this call cannot be attributed to an agent" : null)
  }
];

export function domainsIn(text) {
  const out = [];
  for (const m of String(text).matchAll(/\bhttps?:\/\/([a-z0-9.-]{1,253})(?=[:/?#\s"'\\]|$)/gi)) out.push(m[1].toLowerCase().replace(/\.$/, ""));
  return out;
}

/** Effective mode of a rule given operator overrides. */
export function modeOf(rule, overrides = {}) {
  const m = overrides[rule.id];
  return MODES.includes(m) ? m : rule.mode;
}

/**
 * Run every rule that applies to `on` against `text`.
 * Returns [{ rule, title, severity, mode, controls, detail }].
 */
export function evaluate(on, text, ctx = {}) {
  const findings = [];
  const sample = String(text ?? "").slice(0, 64 * 1024);
  for (const rule of RULES) {
    if (!rule.on.includes(on)) continue;
    if ((ctx.disabled || []).includes(rule.id)) continue;
    let detail = null;
    try {
      detail = rule.test(sample, ctx);
    } catch {
      detail = null;
    }
    if (detail) {
      findings.push({
        rule: rule.id,
        title: rule.title,
        severity: rule.severity,
        mode: modeOf(rule, ctx.modes),
        controls: rule.controls,
        detail
      });
    }
  }
  return findings;
}

export function ruleCatalog(overrides = {}, disabled = []) {
  return RULES.map((r) => ({
    id: r.id,
    title: r.title,
    appliesTo: r.on,
    severity: r.severity,
    mode: disabled.includes(r.id) ? "disabled" : modeOf(r, overrides),
    defaultMode: r.mode,
    controls: r.controls
  }));
}

/**
 * Mask credentials and personal data before text is stored. Uses the
 * guardrail patterns plus the extra credential shapes above. Applied to every
 * preview the audit log keeps, so the log never becomes the place a leaked
 * key ends up being stored a second time.
 */
export function redactForStorage(text) {
  let out = redactPii(String(text ?? "")).text;
  for (const s of SECRET_EXTRA) {
    out = out.replace(new RegExp(s.pattern.source, s.pattern.flags.includes("g") ? s.pattern.flags : s.pattern.flags + "g"), `[REDACTED_${s.name.toUpperCase()}]`);
  }
  return out;
}
