// The audit layer: what every agent did through this gateway.
//
// Layer one of the audit design, the one that covers every agent, because
// every agent has to call a model and every model call here passes through
// the router. From one call it records:
//
//   tool.result  results the agent sent back for tools it ran (the trailing
//                tool messages of the request: what happened since the last
//                model turn, so a resent history is not re-recorded)
//   model.call   the call itself: who, which surface, which model asked for
//                and which served it, tokens, outcome
//   tool.call    tool calls the model proposed in its answer
//
// plus model.blocked (a guardrail stopped the request), auth.failed (a bad,
// revoked or missing key), admin.change (settings, agent keys, reviews) and
// system.start.
//
// What this layer can and cannot see is stated in every status and export:
// it sees what the agent sent the model and what the model asked for. It does
// not see an action the agent took without telling the model, or prove that a
// proposed tool call executed. The hook and MCP-proxy layers close that gap.
//
// Content is never stored raw. Arguments and results are kept as a redacted
// preview (credentials and personal data masked) plus a SHA-256 of the
// original, so an auditor can confirm a later-produced original matches the
// record without the log itself becoming a copy of every secret an agent
// touched. `content: "hash"` drops the preview too.
//
// Nothing here throws into the request path.

import crypto from "node:crypto";
import { getSettings, onSettingsChange } from "../storage/settings.js";
import { currentContext } from "./context.js";
import { evaluate, redactForStorage, domainsIn, ruleCatalog, RULES, decide, isEnforcing } from "./rules.js";
import { appendEvent, readEvents, verifyAudit, writeFailureCount, logPath } from "./log.js";
import { listAgents, hasAgentKeys } from "./agents.js";

const ARGS_PREVIEW = 2_000;
const RESULT_PREVIEW = 600;
const MAX_TOOLS_LISTED = 50;

export function auditEnabled() {
  const env = String(process.env.TOLLPIKE_AUDIT ?? "").trim().toLowerCase();
  if (env === "off" || env === "0" || env === "false") return false;
  return getSettings().audit?.enabled !== false;
}

function config() {
  const a = getSettings().audit || {};
  return {
    content: a.content === "hash" ? "hash" : "redacted",
    modes: a.ruleModes || {},
    disabled: a.disabledRules || [],
    allowedDomains: a.allowedDomains || []
  };
}

function sha256(text) {
  return crypto.createHash("sha256").update(String(text ?? "")).digest("hex");
}

function textOf(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : p?.type === "image_url" ? "[image]" : ""))
      .join("\n");
  }
  return typeof content === "object" ? JSON.stringify(content) : String(content);
}

function preview(text, limit, mode) {
  if (mode === "hash") return undefined;
  const r = redactForStorage(text);
  return r.length > limit ? `${r.slice(0, limit)}... [${r.length - limit} more chars]` : r;
}

function who() {
  const ctx = currentContext();
  if (!ctx) return { source: "local", agent: { id: "local", name: "local process" }, requestId: null, anonymous: false };
  return {
    source: ctx.source,
    agent: ctx.agent,
    requestId: ctx.requestId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    session: ctx.session,
    anonymous: !ctx.agent
  };
}

function flagged(findings) {
  return findings.some((f) => f.mode !== "observe");
}

function topSeverity(findings) {
  const order = ["low", "medium", "high", "critical"];
  return findings.reduce((best, f) => (order.indexOf(f.severity) > order.indexOf(best) ? f.severity : best), findings.length ? "low" : null);
}

function baseEvent(type, w) {
  return {
    type,
    source: w.source,
    agent: w.agent || null,
    requestId: w.requestId || undefined,
    ip: w.ip || undefined,
    session: w.session || undefined
  };
}

// `enforceable` is true only at capture points that see an action before it
// runs. Elsewhere a finding in ask or block mode is recorded with a note that
// it could not be enforced there, so the record never implies a block that
// did not happen.
function finish(event, findings, { enforceable = false } = {}) {
  const wanted = findings.some((f) => isEnforcing(f.mode));
  return appendEvent({
    ...event,
    findings: findings.length ? findings : undefined,
    severity: topSeverity(findings) || undefined,
    flagged: flagged(findings) || undefined,
    enforcement: wanted && !enforceable ? "not enforceable at this capture point: the action had already reached the agent" : event.enforcement
  });
}

// Tool results the agent is reporting now: the tool messages after the last
// assistant turn. Earlier ones were recorded on the request that carried them.
function trailingToolResults(messages) {
  const out = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "tool") out.unshift(m);
    else if (m?.role === "assistant") break;
  }
  return out;
}

function toolNameFor(messages, toolCallId) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const call = messages[i]?.tool_calls?.find?.((c) => c.id === toolCallId);
    if (call) return call.function?.name || null;
  }
  return null;
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return textOf(messages[i].content);
    if (messages[i]?.role === "assistant") return "";
  }
  return "";
}

/**
 * Record a completed model call. `response` is the internal OpenAI-shaped
 * response (buffered, cached, or synthesised from a stream).
 */
export function recordModelCall(request, response, meta = {}) {
  if (!auditEnabled()) return;
  try {
    const cfg = config();
    const w = who();
    const messages = Array.isArray(request?.messages) ? request.messages : [];
    const ruleCtx = { ...cfg, anonymous: w.anonymous };

    for (const m of trailingToolResults(messages)) {
      const text = textOf(m.content);
      const findings = evaluate("tool_result", text, ruleCtx);
      finish(
        {
          ...baseEvent("tool.result", w),
          toolCallId: m.tool_call_id || undefined,
          tool: toolNameFor(messages, m.tool_call_id) || undefined,
          resultChars: text.length,
          resultHash: sha256(text),
          result: preview(text, RESULT_PREVIEW, cfg.content)
        },
        findings
      );
    }

    const prompt = lastUserText(messages);
    const promptFindings = prompt ? evaluate("prompt", prompt, ruleCtx) : [];
    const callFindings = evaluate("model_call", "", ruleCtx);
    const message = response?.choices?.[0]?.message || {};
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const winner = (meta.attempts || []).find((a) => a.ok);

    finish(
      {
        ...baseEvent("model.call", w),
        outcome: "ok",
        modelRequested: request?.model || undefined,
        provider: response?.provider || meta.provider || winner?.provider || undefined,
        model: response?.model || meta.model || undefined,
        stream: meta.stream || undefined,
        cache: meta.cache || undefined,
        messages: messages.length,
        promptChars: prompt.length || undefined,
        promptHash: prompt ? sha256(prompt) : undefined,
        toolsOffered: Array.isArray(request?.tools)
          ? request.tools.slice(0, MAX_TOOLS_LISTED).map((t) => t?.function?.name || t?.name).filter(Boolean)
          : undefined,
        toolCallsProposed: toolCalls.length || undefined,
        finishReason: response?.choices?.[0]?.finish_reason || undefined,
        usage: response?.usage
          ? { prompt: response.usage.prompt_tokens ?? null, completion: response.usage.completion_tokens ?? null, estimated: response.usage_source === "estimated" || undefined }
          : undefined
      },
      [...callFindings, ...promptFindings]
    );

    for (const call of toolCalls) {
      const name = call?.function?.name || call?.name || "unknown";
      const args = typeof call?.function?.arguments === "string" ? call.function.arguments : JSON.stringify(call?.function?.arguments ?? call?.arguments ?? {});
      const findings = evaluate("tool_call", `${name} ${args}`, ruleCtx);
      const domains = [...new Set(domainsIn(args))].slice(0, 10);
      const recorded = finish(
        {
          ...baseEvent("tool.call", w),
          toolCallId: call?.id || undefined,
          tool: name,
          argsChars: args.length,
          argsHash: sha256(args),
          args: preview(args, ARGS_PREVIEW, cfg.content),
          domains: domains.length ? domains : undefined,
          provider: response?.provider || meta.provider || undefined
        },
        findings
      );
      noteAction(recorded, args);
    }
  } catch (err) {
    console.error(`[audit] recordModelCall failed: ${err.message}`);
  }
}

/** Every candidate failed: the call was attempted and nothing answered. */
export function recordModelFailure(request, error, meta = {}) {
  if (!auditEnabled()) return;
  try {
    const w = who();
    finish(
      {
        ...baseEvent("model.call", w),
        outcome: "failed",
        modelRequested: request?.model || undefined,
        stream: meta.stream || undefined,
        messages: Array.isArray(request?.messages) ? request.messages.length : undefined,
        error: String(error?.message || error).slice(0, 200),
        candidatesTried: (error?.attempts || []).filter((a) => !a.skipped).length
      },
      evaluate("model_call", "", { ...config(), anonymous: w.anonymous })
    );
  } catch (err) {
    console.error(`[audit] recordModelFailure failed: ${err.message}`);
  }
}

/** A guardrail refused the request before it reached any provider. */
export function recordBlocked(messages, findings = []) {
  if (!auditEnabled()) return;
  try {
    const w = who();
    finish(
      {
        ...baseEvent("model.blocked", w),
        outcome: "blocked",
        reason: "prompt-injection guardrail",
        guardrailFindings: findings,
        messages: Array.isArray(messages) ? messages.length : undefined
      },
      [{ rule: "guardrail.injection", title: "Request blocked by the injection guardrail", severity: "high", mode: "flag", controls: ["ISO27001:8.16", "SOC2:CC7.2", "ISO42001:A.6.2.6", "EUAIA:Art.15(5)", "NISTAIRMF:MEASURE 2.7", "OWASPLLM:LLM01", "OWASPASI:ASI01"], detail: findings.join(", ") || "blocked" }]
    );
  } catch (err) {
    console.error(`[audit] recordBlocked failed: ${err.message}`);
  }
}

// Failed authentication, coalesced: one event per source IP and reason per
// minute, carrying the count. Without coalescing, anyone able to reach the
// port could fill the disk with auth.failed rows using no key at all.
const authWindow = new Map();
const AUTH_WINDOW_MS = 60_000;

export function recordAuthFailure(req, reason) {
  if (!auditEnabled()) return;
  try {
    const ip = req?.ip || req?.socket?.remoteAddress || "unknown";
    const key = `${ip}|${reason}`;
    const now = Date.now();
    const slot = authWindow.get(key);
    if (slot && now - slot.since < AUTH_WINDOW_MS) {
      slot.count += 1;
      return;
    }
    const suppressed = slot ? slot.count - 1 : 0;
    authWindow.set(key, { since: now, count: 1 });
    if (authWindow.size > 5_000) authWindow.delete(authWindow.keys().next().value);
    finish(
      {
        type: "auth.failed",
        source: "http",
        agent: null,
        ip,
        path: String(req?.originalUrl || req?.url || "").split("?")[0].slice(0, 120),
        reason,
        suppressedSinceLast: suppressed || undefined
      },
      [{ rule: "auth.failed", title: "Failed authentication", severity: reason === "revoked agent key" ? "high" : "medium", mode: "flag", controls: ["ISO27001:8.5", "ISO27001:8.15", "SOC2:CC6.1", "SOC2:CC7.2", "OWASPASI:ASI03"], detail: reason }]
    );
  } catch (err) {
    console.error(`[audit] recordAuthFailure failed: ${err.message}`);
  }
}

/**
 * An administrative change. Recorded even when auditing is switched off by
 * setting, because switching it off is exactly the change that must leave a
 * trace. Only TOLLPIKE_AUDIT=off in the environment silences it, and the
 * startup event records that state.
 */
export function recordAdmin(action, details = {}) {
  const env = String(process.env.TOLLPIKE_AUDIT ?? "").trim().toLowerCase();
  if (env === "off" || env === "0" || env === "false") return;
  try {
    const w = who();
    appendEvent({ ...baseEvent("admin.change", w), action, ...details });
  } catch (err) {
    console.error(`[audit] recordAdmin failed: ${err.message}`);
  }
}

export function recordStartup(info = {}) {
  const env = String(process.env.TOLLPIKE_AUDIT ?? "").trim().toLowerCase();
  if (env === "off" || env === "0" || env === "false") return;
  const v = verifyAudit();
  appendEvent({
    type: "system.start",
    source: "local",
    agent: null,
    auditEnabled: auditEnabled(),
    keyed: v.keyed,
    chainIntactAtStart: v.total ? v.intact : null,
    ...info
  });
}

// --- recent actions, for endpoint correlation -------------------------------
//
// The endpoint layer explains an agent's processes by matching them to the
// tool calls the other capture points recorded. Those are kept here, briefly:
// the last 2,000 actions or 15 minutes, whichever is smaller.

const ACTIONS_MAX = 2_000;
const ACTIONS_TTL_MS = 15 * 60 * 1000;
const actions = [];

function commandOf(input) {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    for (const k of ["command", "cmd", "script", "commandLine"]) if (typeof input[k] === "string") return input[k];
  }
  if (typeof input === "string") {
    try {
      return commandOf(JSON.parse(input));
    } catch {
      return input;
    }
  }
  return stringify(input);
}

function noteAction(event, input) {
  if (!event?.id) return;
  actions.push({ ts: event.ts, command: commandOf(input), eventId: event.id, type: event.type, toolUseId: event.toolUseId, agent: event.agent || null });
  if (actions.length > ACTIONS_MAX) actions.splice(0, actions.length - ACTIONS_MAX);
}

export function recentActions() {
  const cutoff = Date.now() - ACTIONS_TTL_MS;
  while (actions.length && Date.parse(actions[0].ts) < cutoff) actions.shift();
  return actions;
}

/** An endpoint event the endpoint layer decided to keep. */
export function recordEndpointEvent(event, findings = []) {
  if (!auditEnabled()) return null;
  try {
    const cfg = config();
    const cmd = event.commandLine;
    const { commandLine, ...rest } = event;
    return finish(
      {
        ...rest,
        agent: event.agent || null,
        commandLineChars: cmd ? cmd.length : undefined,
        commandLineHash: cmd ? sha256(cmd) : undefined,
        commandLine: cmd ? preview(cmd, ARGS_PREVIEW, cfg.content) : undefined
      },
      findings
    );
  } catch (err) {
    console.error(`[audit] recordEndpointEvent failed: ${err.message}`);
    return null;
  }
}

// --- vendor audit logs -----------------------------------------------------

const DETAILS_MAX = 2_000;

/**
 * A record pulled from a vendor's audit log. The content of a prompt or
 * response, when the vendor supplies it, has already been scanned by the
 * caller and is kept here only as a hash and a length.
 */
export function recordVendorEvent(r, findings = []) {
  if (!auditEnabled()) return null;
  try {
    let details;
    if (r.details && typeof r.details === "object") {
      const json = redactForStorage(JSON.stringify(r.details));
      details = json.length > DETAILS_MAX ? { truncated: json.slice(0, DETAILS_MAX) } : JSON.parse(json);
    }
    return finish(
      {
        type: "vendor.activity",
        source: `vendor:${r.vendor}`,
        agent: null,
        vendor: r.vendor,
        product: r.product || undefined,
        vendorEventId: String(r.vendorId).slice(0, 200),
        vendorTime: r.ts || undefined,
        action: r.action ? String(r.action).slice(0, 200) : undefined,
        actor: r.actor ? { id: r.actor.id ? String(r.actor.id).slice(0, 200) : undefined, email: r.actor.email ? String(r.actor.email).slice(0, 200) : undefined, type: r.actor.type || undefined } : undefined,
        ip: r.ip || undefined,
        target: r.target ? String(r.target).slice(0, 300) : undefined,
        contentChars: r.content ? String(r.content).length : undefined,
        contentHash: r.content ? sha256(r.content) : undefined,
        details
      },
      findings
    );
  } catch (err) {
    console.error(`[audit] recordVendorEvent failed: ${err.message}`);
    return null;
  }
}

// --- actions seen before and after they run --------------------------------
//
// The capture points of layer two: an agent runtime's own hooks (Claude Code
// PreToolUse / PostToolUse) and the MCP proxy. Unlike the model connection,
// these see the action itself, so the record is ground truth rather than what
// the model proposed, and a rule in ask or block mode can actually stop it.
//
//   tool.requested  the agent is about to run a tool; carries the decision
//   tool.executed   the tool ran; carries its status and a redacted result
//   prompt.submitted, session.start, session.end  agent lifecycle

function stringify(value) {
  if (value == null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function actionBase(type, w, a) {
  return {
    ...baseEvent(type, w),
    source: a.source || w.source,
    agentSession: a.session ? String(a.session).slice(0, 80) : undefined,
    subagent: a.subagent ? String(a.subagent).slice(0, 60) : undefined,
    cwd: a.cwd ? String(a.cwd).slice(0, 300) : undefined,
    toolUseId: a.toolUseId ? String(a.toolUseId).slice(0, 80) : undefined,
    tool: a.tool ? String(a.tool).slice(0, 120) : undefined
  };
}

/**
 * An action the agent is about to take. Returns { decision, reason, event }
 * where decision is "block", "ask" or null (no objection: the agent's own
 * permission rules then apply as normal). Never "allow": the audit layer
 * can withhold permission but never grants it.
 */
export function recordToolRequest(a = {}) {
  if (!auditEnabled()) return { decision: null, reason: null, event: null };
  try {
    const cfg = config();
    const w = who();
    const input = stringify(a.input);
    const findings = evaluate("tool_call", `${a.tool || ""} ${input}`, { ...cfg, anonymous: w.anonymous, permissionMode: a.permissionMode });
    const { decision, because } = decide(findings);
    const enforced = decision && (decision === "block" || a.canAsk) ? decision : null;
    const reason = because.length
      ? `Tollpike audit policy: ${because.map((f) => `${f.title} (${f.rule}): ${f.detail}`).join("; ")}`
      : null;
    const domains = [...new Set(domainsIn(input))].slice(0, 10);
    const event = finish(
      {
        ...actionBase("tool.requested", w, a),
        permissionMode: a.permissionMode || undefined,
        inputChars: input.length,
        inputHash: sha256(input),
        input: preview(input, ARGS_PREVIEW, cfg.content),
        domains: domains.length ? domains : undefined,
        decision: enforced || "no-objection",
        enforcement: decision && !enforced ? `${decision} requested, but this capture point cannot ask a person; recorded as flagged` : undefined
      },
      findings,
      { enforceable: true }
    );
    noteAction(event, a.input);
    return { decision: enforced, reason: enforced ? reason : null, event };
  } catch (err) {
    console.error(`[audit] recordToolRequest failed: ${err.message}`);
    return { decision: null, reason: null, event: null };
  }
}

/**
 * A tool that ran. Returns { withhold, reason } where withhold is true when a
 * result rule in block mode fired (prompt injection in what the tool
 * returned): the capture point can then keep the result away from the model.
 */
export function recordToolExecuted(a = {}) {
  if (!auditEnabled()) return { withhold: false, reason: null, event: null };
  try {
    const cfg = config();
    const w = who();
    const output = stringify(a.output);
    const findings = evaluate("tool_result", output, { ...cfg, anonymous: w.anonymous });
    const blocking = findings.filter((f) => f.mode === "block");
    const reason = blocking.length
      ? `Tollpike audit policy withheld this tool result: ${blocking.map((f) => `${f.title}: ${f.detail}`).join("; ")}`
      : null;
    const event = finish(
      {
        ...actionBase("tool.executed", w, a),
        status: a.status === "error" ? "error" : "success",
        durationMs: Number.isFinite(a.durationMs) ? Math.round(a.durationMs) : undefined,
        resultChars: output.length,
        resultHash: sha256(output),
        result: preview(output, RESULT_PREVIEW, cfg.content),
        withheld: blocking.length ? true : undefined
      },
      findings,
      { enforceable: true }
    );
    return { withhold: blocking.length > 0, reason, event };
  } catch (err) {
    console.error(`[audit] recordToolExecuted failed: ${err.message}`);
    return { withhold: false, reason: null, event: null };
  }
}

/** A prompt typed into an agent. Block mode on a prompt rule stops it being sent. */
export function recordPrompt(a = {}) {
  if (!auditEnabled()) return { block: false, reason: null };
  try {
    const cfg = config();
    const w = who();
    const text = stringify(a.prompt);
    const findings = evaluate("prompt", text, { ...cfg, anonymous: w.anonymous });
    const blocking = findings.filter((f) => f.mode === "block");
    finish(
      {
        ...actionBase("prompt.submitted", w, a),
        promptChars: text.length,
        promptHash: sha256(text),
        decision: blocking.length ? "block" : "no-objection"
      },
      findings,
      { enforceable: true }
    );
    return {
      block: blocking.length > 0,
      reason: blocking.length ? `Tollpike audit policy: ${blocking.map((f) => `${f.title}: ${f.detail}`).join("; ")}` : null
    };
  } catch (err) {
    console.error(`[audit] recordPrompt failed: ${err.message}`);
    return { block: false, reason: null };
  }
}

export function recordSession(kind, a = {}) {
  if (!auditEnabled()) return;
  try {
    const w = who();
    appendEvent({ ...actionBase(kind === "end" ? "session.end" : "session.start", w, a), detail: a.detail ? String(a.detail).slice(0, 60) : undefined });
  } catch (err) {
    console.error(`[audit] recordSession failed: ${err.message}`);
  }
}

// --- review ---------------------------------------------------------------

const DECISIONS = ["acknowledged", "false_positive", "escalated", "resolved"];

/** Record a review of a flagged event. Appends; never edits the original. */
export function reviewEvent({ eventId, reviewer, decision, note }) {
  if (typeof eventId !== "string" || !/^evt_[a-z0-9]{6,40}$/.test(eventId)) return { ok: false, error: "eventId must be an audit event id (evt_...)." };
  if (!DECISIONS.includes(decision)) return { ok: false, error: `decision must be one of: ${DECISIONS.join(", ")}.` };
  const name = String(reviewer ?? "").trim();
  if (!name || name.length > 80) return { ok: false, error: "reviewer is required (who is signing off), up to 80 characters." };
  const target = readEvents().find((e) => e.id === eventId);
  if (!target) return { ok: false, error: `No event ${eventId}.` };
  if (target.type === "review") return { ok: false, error: "A review cannot itself be reviewed." };
  const row = appendEvent({
    type: "review",
    source: who().source,
    agent: who().agent || null,
    target: eventId,
    targetType: target.type,
    reviewer: name,
    decision,
    note: note ? String(note).slice(0, 1000) : undefined
  });
  return { ok: true, review: row };
}

// --- queries --------------------------------------------------------------

function inPeriod(e, from, to) {
  if (from && e.ts < from) return false;
  if (to && e.ts > to) return false;
  return true;
}

function normaliseBound(v, end = false) {
  if (!v) return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return end ? `${s}T23:59:59.999Z` : `${s}T00:00:00.000Z`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Flagged events with no review yet, oldest first. */
export function reviewQueue(events = readEvents()) {
  const reviewed = new Set(events.filter((e) => e.type === "review").map((e) => e.target));
  return events.filter((e) => e.flagged && !reviewed.has(e.id));
}

export function queryEvents({ from, to, type, agent, severity, flaggedOnly = false, unreviewedOnly = false, tool, limit = 100 } = {}) {
  const f = normaliseBound(from);
  const t = normaliseBound(to, true);
  const order = ["low", "medium", "high", "critical"];
  let events = readEvents();
  const pool = unreviewedOnly ? reviewQueue(events) : events;
  const out = pool.filter((e) => {
    if (!inPeriod(e, f, t)) return false;
    if (type && e.type !== type && !String(e.type).startsWith(`${type}.`)) return false;
    if (agent && e.agent?.id !== agent && e.agent?.name !== agent) return false;
    if (tool && e.tool !== tool) return false;
    if (flaggedOnly && !e.flagged) return false;
    if (severity && order.indexOf(e.severity) < order.indexOf(severity)) return false;
    return true;
  });
  const n = Math.min(Math.max(Number(limit) || 100, 1), 5_000);
  events = null;
  return { ok: true, total: out.length, returned: Math.min(n, out.length), events: out.slice(-n).reverse() };
}

export function auditSummary({ from, to } = {}) {
  const f = normaliseBound(from);
  const t = normaliseBound(to, true);
  const events = readEvents().filter((e) => inPeriod(e, f, t));
  const byType = {};
  const byAgent = {};
  const byRule = {};
  const tools = {};
  let anonymousCalls = 0;
  for (const e of events) {
    byType[e.type] = (byType[e.type] || 0) + 1;
    const a = e.agent?.name || (e.type === "model.call" ? "(unattributed)" : null);
    if (a && (e.type === "model.call" || e.type.startsWith("tool."))) byAgent[a] = (byAgent[a] || 0) + 1;
    if (e.type === "model.call" && !e.agent) anonymousCalls += 1;
    if (e.type === "tool.call") tools[e.tool] = (tools[e.tool] || 0) + 1;
    for (const x of e.findings || []) byRule[x.rule] = (byRule[x.rule] || 0) + 1;
  }
  const queue = reviewQueue(readEvents()).filter((e) => inPeriod(e, f, t));
  return {
    ok: true,
    period: { from: f, to: t },
    events: events.length,
    byType,
    byAgent,
    findingsByRule: byRule,
    topTools: Object.entries(tools).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([tool, count]) => ({ tool, count })),
    anonymousModelCalls: anonymousCalls,
    flagged: events.filter((e) => e.flagged).length,
    awaitingReview: queue.length
  };
}

/** Coverage and configuration, including what this layer cannot see. */
export function auditStatus() {
  const s = getSettings();
  const v = verifyAudit();
  const agents = listAgents({ includeRevoked: false });
  const gaps = [];
  if (!auditEnabled()) gaps.push("Auditing is OFF: model calls are not being recorded.");
  if (!v.keyed) gaps.push("TOLLPIKE_SECRET is not set, so the audit chain is unkeyed and not tamper-evident against a local editor.");
  if (!s.gatewayApiKey) gaps.push("No operator (gateway) key: the control panel and admin API are open to anyone who can reach the port.");
  if (!hasAgentKeys()) gaps.push("No agent keys: model calls cannot be attributed to individual agents, and unkeyed callers are accepted.");
  if (v.writeFailures) gaps.push(`${v.writeFailures} audit write(s) failed since start: the record has a gap.`);
  gaps.push("Direct provider access is not blocked by Tollpike itself. Enforce it at the network (docs/audit-egress.md), or agents can bypass the record.");
  const sinceMs = Date.now() - 30 * 24 * 3600 * 1000;
  const captureSources = {};
  for (const e of readEvents()) {
    if (Date.parse(e.ts) < sinceMs) continue;
    if (e.type === "model.call" || e.type.startsWith("tool.") || e.type === "prompt.submitted") captureSources[e.source] = (captureSources[e.source] || 0) + 1;
  }
  const preExecution = (captureSources["claude-code"] || 0) + (captureSources["mcp-proxy"] || 0);
  if (!preExecution) {
    gaps.push("No events from Claude Code hooks or the MCP proxy in the last 30 days: Tollpike sees only what agents tell the model, cannot confirm what ran, and cannot block. Wire them up: tollpike hook config, tollpike mcp-proxy.");
  }
  return {
    ok: true,
    enabled: auditEnabled(),
    logPath,
    content: config().content,
    retentionDays: s.audit?.retentionDays ?? 365,
    chain: { intact: v.intact, keyed: v.keyed, total: v.total },
    agents: { active: agents.length, requireKeyOnModelEndpoints: hasAgentKeys() },
    operatorKeySet: Boolean(s.gatewayApiKey),
    captureSources,
    sees: [
      "every model call routed through Tollpike, on all four API formats and the MCP/A2A completion tools",
      "tool calls the model proposed, with redacted arguments, and the tool results the agent reported back",
      "Claude Code tool executions before and after they run, with their real results, when its hooks point here (can block)",
      "every MCP tool call routed through the MCP proxy, before and after it runs (can block)",
      "processes in an agent's tree on machines with an endpoint sensor, matched to the audited action that explains them",
      "connections to model providers from anywhere but the gateway, on machines with an endpoint sensor",
      "hosted agents' own audit logs (ChatGPT, Claude, Microsoft 365 Copilot, GitHub Copilot, Gemini) for vendors with a configured connector",
      "failed authentication, guardrail blocks, admin changes and reviews"
    ],
    doesNotSee: [
      "for agents wired to neither hooks nor the MCP proxy: actions they took without telling the model, and proof that a proposed call ran",
      "activity on machines with no endpoint sensor; and on sensor machines, activity outside an agent's process tree (Tollpike is not an EDR)",
      "agents that call a provider directly, unless direct access is blocked at the network",
      "hosted agents whose vendor has no audit-log API on your plan, or whose connector is not configured; and anything a vendor does not put in its own log"
    ],
    gaps,
    rules: ruleCatalog(config().modes, config().disabled)
  };
}

// --- evidence -------------------------------------------------------------

// What each control is evidenced by in an export. Only controls this layer
// produces evidence for are listed; the rest of an ISMS is outside a tool.
export const CONTROL_MAP = [
  { iso: "8.15 Logging", soc2: "CC7.2", iso42001: "A.6.2.8 AI system recording of event logs", euAiAct: "Art. 12 Record-keeping; Art. 19 and 26(6) log retention of at least six months (append-only, never pruned)", nistAiRmf: "MEASURE 2.8 Transparency and accountability; MANAGE 4.1 Post-deployment monitoring", owaspLlm: "", owaspAgentic: "", evidence: "hash-chained audit log of every model call, tool call and tool result; chain verification report" },
  { iso: "8.16 Monitoring activities", soc2: "CC7.2, CC4.1", iso42001: "A.6.2.6 AI system operation and monitoring", euAiAct: "Art. 26(5) Monitoring of operation; Art. 15(5) resilience to manipulation (prompt injection findings)", nistAiRmf: "MEASURE 2.4 Monitored in production; MEASURE 3.1 Emergent risks tracked; MEASURE 2.7 Security and resilience (prompt injection findings)", owaspLlm: "LLM01 Prompt Injection (findings in tool results); LLM02 Sensitive Information Disclosure", owaspAgentic: "ASI01 Agent Goal Hijack (injection in content the agent reads); ASI06 Memory and Context Poisoning (supporting: injected tool results withheld from the context)", evidence: "risk rules evaluated on every event; findings by rule" },
  { iso: "5.25 Assessment and decision on information security events", soc2: "CC7.3, CC7.4", iso42001: "A.6.2.6 AI system operation and monitoring, A.8.4 Communication of incidents (supporting)", euAiAct: "Art. 26(2) Human oversight by assigned persons (review sign-offs); Art. 26(5) and 73 incident records (supporting)", nistAiRmf: "MANAGE 4.3 Incidents tracked and responded to; GOVERN 4.3 Identification of incidents", owaspLlm: "", owaspAgentic: "", evidence: "flagged events and their review records (reviewer, decision, note)" },
  { iso: "8.12 Data leakage prevention, 8.11 Data masking", soc2: "C1.1, CC6.7", iso42001: "A.9.2 Processes for responsible use of AI systems", euAiAct: "", nistAiRmf: "MEASURE 2.10 Privacy risk examined and documented", owaspLlm: "LLM02 Sensitive Information Disclosure; LLM07 System Prompt Leakage (credentials in prompts)", owaspAgentic: "", evidence: "credential and personal-data findings; content stored redacted or as hashes only" },
  { iso: "5.15 Access control, 5.16 Identity management, 5.18 Access rights", soc2: "CC6.1, CC6.2, CC6.3", iso42001: "A.3.2 AI roles and responsibilities (supporting), A.4.2 Resource documentation", euAiAct: "Art. 12 (every event attributed to the agent that caused it)", nistAiRmf: "MEASURE 2.8 (every event attributed to the agent that caused it)", owaspLlm: "LLM06 Excessive Agency (agent keys reach model endpoints only, with read-only MCP)", owaspAgentic: "ASI03 Identity and Privilege Abuse (one key per agent, scoped to model endpoints)", evidence: "agent key register (created, revoked), per-agent attribution, unattributed-call count" },
  { iso: "8.5 Secure authentication", soc2: "CC6.1", iso42001: "", euAiAct: "", nistAiRmf: "", owaspLlm: "", owaspAgentic: "ASI03 Identity and Privilege Abuse (failed and revoked-key events)", evidence: "failed and revoked-key authentication events" },
  { iso: "8.32 Change management, 8.9 Configuration management", soc2: "CC8.1", iso42001: "", euAiAct: "", nistAiRmf: "MANAGE 4.1 (change management, supporting)", owaspLlm: "", owaspAgentic: "", evidence: "admin.change events: settings keys changed, agent keys issued and revoked" },
  { iso: "8.17 Clock synchronization", soc2: "CC7.2 (supporting)", iso42001: "", euAiAct: "", nistAiRmf: "", owaspLlm: "", owaspAgentic: "", evidence: "UTC timestamps from the host clock; synchronisation is the host's responsibility (NTP) and is not verified by Tollpike" },
  { iso: "8.18 Use of privileged utility programs, 8.7 Protection against malware", soc2: "CC6.8, CC7.2", iso42001: "A.9.2 Processes for responsible use of AI systems, A.9.4 Intended use of the AI system", euAiAct: "Art. 14 Human oversight (ask puts a person in the loop, block stops the action)", nistAiRmf: "MANAGE 2.4 Supersede or disengage (block); MAP 3.5 Human oversight (ask)", owaspLlm: "LLM06 Excessive Agency (block, ask); LLM05 Improper Output Handling (model-proposed commands checked before they run); LLM01 (actions an injection drives are stopped)", owaspAgentic: "ASI02 Tool Misuse and Exploitation; ASI05 Unexpected Code Execution (checked, blocked or asked before it runs); ASI04 (supporting: third-party MCP servers sit behind the audited proxy)", evidence: "pre-execution decisions (tool.requested with block or ask) from Claude Code hooks and the MCP proxy, each naming the rule that decided; withheld tool results" },
  { iso: "8.16 Monitoring activities, 8.15 Logging (endpoint)", soc2: "CC7.2, CC7.3", iso42001: "A.6.2.6 AI system operation and monitoring, A.6.2.8 AI system recording of event logs", euAiAct: "Art. 26(5) Monitoring of operation; Art. 12 (supporting)", nistAiRmf: "MEASURE 2.4 Monitored in production; MEASURE 3.1 Emergent risks tracked", owaspLlm: "LLM06 Excessive Agency (agent processes no action explains)", owaspAgentic: "ASI05 Unexpected Code Execution (processes no action explains); ASI10 Rogue Agents", evidence: "agent processes from OS telemetry matched to audited actions; unexplained agent activity flagged; sensor heartbeats showing monitoring ran" },
  { iso: "8.20 Networks security, 5.23 Cloud services", soc2: "CC6.6", iso42001: "A.9.4 Intended use of the AI system, A.4.5 System and computing resources", euAiAct: "Art. 12 and 26(5) (AI use that would escape the log is detected)", nistAiRmf: "GOVERN 1.6 (AI use outside the inventory is detected); MEASURE 2.8", owaspLlm: "LLM10 Unbounded Consumption (supporting: calls that skip the gateway's spend caps and rate limits)", owaspAgentic: "ASI10 Rogue Agents (an agent that goes around the gateway)", evidence: "connections to model providers that bypassed the gateway, from endpoint telemetry" },
  { iso: "5.23 Information security for use of cloud services, 8.15 Logging", soc2: "CC9.2, CC7.2", iso42001: "A.10.3 Suppliers, A.6.2.8 AI system recording of event logs", euAiAct: "Art. 26(5) Monitoring of operation of hosted AI services", nistAiRmf: "MANAGE 3.1 Third-party AI monitored; GOVERN 6.1 (supporting)", owaspLlm: "LLM03 Supply Chain (supporting: hosted AI services' own logs)", owaspAgentic: "ASI04 Agentic Supply Chain (supporting: hosted AI services' own logs); ASI03 (privileged changes)", evidence: "hosted AI services' own audit logs pulled into the chain (vendor.activity), with collection runs recorded (vendor.pull)" },
  { iso: "5.9 Inventory of information and other associated assets", soc2: "CC6.1 (supporting)", iso42001: "A.4.2 Resource documentation, A.4.4 Tooling resources, A.4.5 System and computing resources", euAiAct: "Art. 6 classification (supporting: lists every AI system in use)", nistAiRmf: "GOVERN 1.6 Inventory of AI systems", owaspLlm: "LLM03 Supply Chain (supporting: which models and providers are in use)", owaspAgentic: "ASI04 Agentic Supply Chain (supporting: models and providers in use)", evidence: "AI system inventory: the providers and models each agent used in the period, with call counts" },
  { iso: "5.28 Collection of evidence", soc2: "CC2.1", iso42001: "Clause 7.5 Documented information, Clause 9.1 Monitoring, measurement, analysis and evaluation", euAiAct: "Art. 19 and 26(6) (logs kept and producible on request)", nistAiRmf: "GOVERN 1.5 Ongoing monitoring and periodic review (supporting)", owaspLlm: "", owaspAgentic: "", evidence: "this export: period-bounded events with the chain head that commits to them" }
];

/** The evidence pack as a document an auditor reads before opening the JSON. */
export function evidenceMarkdown(pack) {
  const v = pack.verification;
  const s = pack.summary;
  const period = `${pack.period.from || "beginning of log"} to ${pack.period.to || pack.generatedAt}`;
  const anchor = v.anchorOk === null ? "not keyed" : v.anchorOk ? "verifies" : "does not verify";
  const lines = [
    "# Tollpike audit evidence",
    "",
    `Generated ${pack.generatedAt} for the period ${period}.`,
    "",
    "## Integrity",
    "",
    `- Chain: ${v.intact ? "intact" : "NOT INTACT"}, ${v.total} rows, ${v.algo}${v.keyed ? " (keyed)" : " (unkeyed)"}.`,
    `- Broken links: ${v.brokenLinks}. Truncated: ${v.truncated ? "yes" : "no"}. Rolled back: ${v.rolledBack ? "yes" : "no"}. Anchor: ${anchor}.`,
    `- Chain head at export: ${v.head}. Recording this value outside Tollpike lets a later export prove that nothing before it was rewritten.`,
    `- ${v.note}`,
    "",
    "## Activity in the period",
    "",
    `- ${s.events} events: ${Object.entries(s.byType).map(([k, n]) => `${n} ${k}`).join(", ") || "none"}.`,
    `- Model calls with no agent identity: ${s.anonymousModelCalls}.`,
    `- Flagged: ${s.flagged}. Awaiting review: ${s.awaitingReview}.`,
    `- Findings by rule: ${Object.entries(s.findingsByRule).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}.`,
    "",
    "## Agents (access register)",
    "",
    "| Agent | Id | Created | Revoked |",
    "|---|---|---|---|",
    ...(pack.agents.length ? pack.agents.map((a) => `| ${a.name} | ${a.id} | ${a.createdAt} | ${a.revokedAt || "active"} |`) : ["| (none issued) | | | |"]),
    "",
    "## AI systems in use (ISO/IEC 42001 A.4)",
    "",
    "| Agent | Model calls | Provider / model (calls) |",
    "|---|---|---|",
    ...((pack.aiInventory || []).length
      ? pack.aiInventory.map((r) => `| ${r.agent} | ${r.calls} | ${r.systems.map((s) => `${s.system} (${s.calls})`).join(", ")} |`)
      : ["| (no model calls in the period) | | |"]),
    "",
    "## Controls this evidence supports",
    "",
    "| ISO/IEC 27001:2022 Annex A | ISO/IEC 42001:2023 | SOC 2 TSC | EU AI Act | NIST AI RMF | OWASP LLM Top 10 | OWASP Agentic Top 10 | Evidence |",
    "|---|---|---|---|---|---|---|---|",
    ...pack.controls.map((c) => `| ${c.iso} | ${c.iso42001 || "-"} | ${c.soc2} | ${c.euAiAct || "-"} | ${c.nistAiRmf || "-"} | ${c.owaspLlm || "-"} | ${c.owaspAgentic || "-"} | ${c.evidence} |`),
    "",
    "## Configuration gaps at export",
    "",
    ...(pack.status.gaps.length ? pack.status.gaps.map((g) => `- ${g}`) : ["- None reported."]),
    "",
    "## Limitations",
    "",
    ...pack.limitations.map((l) => `- ${l}`),
    ""
  ];
  return lines.join("\n");
}

// The AI systems in use (ISO/IEC 42001 A.4): which providers and models each
// agent called in the period, from the model.call events themselves.
function aiInventory(events) {
  const byAgent = new Map();
  for (const e of events) {
    if (e.type !== "model.call") continue;
    const key = e.agent?.id || "unattributed";
    if (!byAgent.has(key)) byAgent.set(key, { agent: e.agent?.name || "(no agent identity)", agentId: e.agent?.id || null, calls: 0, systems: new Map() });
    const row = byAgent.get(key);
    row.calls++;
    const sys = `${e.provider || "unknown provider"} / ${e.model || e.modelRequested || "unknown model"}`;
    row.systems.set(sys, (row.systems.get(sys) || 0) + 1);
  }
  return [...byAgent.values()]
    .map((r) => ({ ...r, systems: [...r.systems].map(([system, calls]) => ({ system, calls })).sort((a, b) => b.calls - a.calls) }))
    .sort((a, b) => b.calls - a.calls);
}

export function exportEvidence({ from, to } = {}) {
  const f = normaliseBound(from);
  const t = normaliseBound(to, true);
  const all = readEvents();
  const events = all.filter((e) => inPeriod(e, f, t));
  const status = auditStatus();
  return {
    ok: true,
    kind: "tollpike-audit-evidence",
    version: 1,
    generatedAt: new Date().toISOString(),
    period: { from: f, to: t },
    verification: verifyAudit(),
    status,
    summary: auditSummary({ from, to }),
    agents: listAgents({ includeRevoked: true }),
    aiInventory: aiInventory(events),
    rules: status.rules,
    controls: CONTROL_MAP,
    adminChanges: events.filter((e) => e.type === "admin.change"),
    reviews: events.filter((e) => e.type === "review"),
    openFlags: reviewQueue(all).filter((e) => inPeriod(e, f, t)),
    events,
    limitations: [
      "Evidence for the technical controls listed only. An ISO 27001 or SOC 2 audit also covers policy, risk assessment, people, suppliers and physical security, which no tool can evidence.",
      "ISO/IEC 42001 also requires an AI policy (A.2), AI system impact assessments (A.5), governance of data used to develop AI systems (A.7) and information for interested parties (A.8). Those are organisational work this export does not evidence. The AI system inventory covers only model calls that passed through the gateway.",
      "EU AI Act (Regulation (EU) 2024/1689): the deployer duties in Article 26 apply to high-risk AI systems, from 2 December 2027 for Annex III systems after the 2026 Digital Omnibus. Most AI agent use is not high-risk, and for it this mapping is good practice rather than a legal duty. Tollpike does not classify systems, and does not evidence AI literacy (Art. 4), fundamental rights impact assessments (Art. 27), transparency to people (Art. 50) or provider obligations such as conformity assessment.",
      "NIST AI RMF 1.0 (NIST AI 100-1) is voluntary. Its GOVERN function is mostly organisational (policies, culture, workforce) and MAP mostly concerns context and impact. This export evidences parts of MEASURE and MANAGE and the AI inventory (GOVERN 1.6), not the framework as a whole. The Generative AI Profile (NIST AI 600-1) files its suggested actions under the same subcategories.",
      "OWASP Top 10 for LLM Applications 2025 is a list of risks, not controls. For agent traffic it sees, Tollpike detects or limits LLM01, LLM02, LLM05, LLM06 and LLM07, and supports LLM03 and LLM10. It does nothing for data and model poisoning (LLM04), vector and embedding weaknesses (LLM08) or misinformation (LLM09). The gateway's spend caps and rate limits also address LLM10, but this export does not evidence them.",
      "OWASP Top 10 for Agentic Applications 2026 is also a list of risks. For agent actions it sees, Tollpike detects or limits ASI01, ASI02, ASI03, ASI05 and ASI10, and supports ASI04 and ASI06 (injected tool results are withheld, but persistent agent memory is not visible). It does not address insecure inter-agent communication (ASI07), cascading failures (ASI08) or human-agent trust exploitation (ASI09).",
      "SOC 2 Type II assesses controls over an operating period. This export covers only the period requested, and only while auditing was enabled (see system.start events).",
      ...status.doesNotSee.map((d) => `Not visible to this layer: ${d}.`)
    ]
  };
}

// Settings writes become admin.change events. Values are recorded for the
// fields an auditor needs to see (what the controls were set to); credentials
// and proxy URLs, which can carry passwords, are recorded as changed only.
const VALUE_FIELDS = new Set([
  "audit", "disabledProviders", "budgetCapsUsd", "injectionMode", "redactPii", "tlsProfile",
  "quotaTracking", "defaultCombo", "gamification", "subscriptionProviders"
]);

onSettingsChange(({ changed, before, after }) => {
  const changes = changed.map((k) => {
    if (k === "gatewayApiKey") return { key: k, change: after[k] ? (before[k] ? "rotated" : "set") : "cleared" };
    if (VALUE_FIELDS.has(k)) return { key: k, from: before[k] ?? null, to: after[k] ?? null };
    return { key: k, change: "updated" };
  });
  recordAdmin("settings.update", { changes });
});

export { verifyAudit, readEvents, RULES };
