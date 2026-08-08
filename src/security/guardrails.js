// Guardrails are OFF by default and opt-in per-install, because both of
// these are heuristics that produce false positives, and silently mangling
// a user's prompt is worse than not scanning it.
//
// IMPORTANT HONESTY NOTE, also stated in the README: neither of these is a
// security boundary. PII redaction here is pattern matching, not a DLP
// product — it catches common well-formed identifiers and will miss
// unusual formats, names, addresses, and anything contextual. Prompt-
// injection detection is a known-unsolved problem; these patterns catch
// low-effort attempts and will not stop a determined adversary. Treat both
// as defence-in-depth that reduces accidental leakage, not as a guarantee.

// --- PII redaction -------------------------------------------------------

const PII_PATTERNS = [
  {
    name: "email",
    // Deliberately conservative: requires a plausible TLD.
    //
    // Every quantifier here is BOUNDED, and that is a correctness fix as much
    // as a performance one. Unbounded, this was quadratic: `[A-Za-z0-9._%+-]+`
    // followed by a required `@` means that on a long run of local-part-legal
    // characters with no `@` anywhere, the engine consumes the run, fails, gives
    // the whole run back one character at a time, then restarts one position
    // along and does it again. 128KB of "a.b_c%d+e-" took 14 seconds; the 10mb
    // body limit allows ~80x that.
    //
    // The irony worth noting: this pattern only runs when redactPii is enabled,
    // so turning ON a data-protection feature was what exposed the gateway.
    //
    // The bounds are the real limits from RFC 5321, so nothing that was matched
    // before stops being matched: local part <= 64 octets, domain <= 253, and
    // no TLD approaches 24 characters.
    pattern: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/g,
    replacement: "[REDACTED_EMAIL]"
  },
  {
    name: "credit_card",
    // 13-19 digits with optional separators. Validated with Luhn below to
    // cut false positives on order numbers and long IDs.
    pattern: /\b(?:\d[ -]*?){13,19}\b/g,
    replacement: "[REDACTED_CARD]",
    validate: luhnCheck
  },
  {
    name: "iban",
    // Belgian/EU IBANs — relevant given this runs in the EU.
    pattern: /\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9]{4}[ ]?){2,7}[A-Z0-9]{1,4}\b/g,
    replacement: "[REDACTED_IBAN]"
  },
  {
    name: "api_key",
    // Common vendor key shapes. Catching a leaked key before it's shipped
    // to a third-party model is the highest-value redaction here.
    pattern: /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{36}|AIza[A-Za-z0-9_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    replacement: "[REDACTED_KEY]"
  },
  {
    name: "private_key_block",
    pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]"
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: "[REDACTED_JWT]"
  }
];

function luhnCheck(candidate) {
  const digits = candidate.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function redactPii(text) {
  if (!text || typeof text !== "string") return { text, found: [] };

  let output = text;
  const found = [];

  for (const rule of PII_PATTERNS) {
    output = output.replace(rule.pattern, (match) => {
      if (rule.validate && !rule.validate(match)) return match; // e.g. failed Luhn
      found.push(rule.name);
      return rule.replacement;
    });
  }

  return { text: output, found: [...new Set(found)] };
}

// --- Prompt-injection heuristics ----------------------------------------

const INJECTION_PATTERNS = [
  { name: "instruction_override", pattern: /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?|directions?)\b/i },
  { name: "role_hijack", pattern: /\b(?:you\s+are\s+now|from\s+now\s+on\s+you\s+are|act\s+as\s+if\s+you\s+are)\b.{0,60}\b(?:unrestricted|jailbroken|DAN|no\s+longer\s+bound|developer\s+mode)\b/i },
  { name: "system_prompt_exfil", pattern: /\b(?:reveal|show|print|repeat|output|what\s+(?:is|are))\s+(?:me\s+)?(?:your\s+)?(?:system\s+prompt|initial\s+instructions|hidden\s+rules)\b/i },
  { name: "fake_system_turn", pattern: /(?:^|\n)\s*(?:<\|im_start\|>|<\|system\|>|\[system\]|###\s*system)/i },
  { name: "delimiter_escape", pattern: /(?:<\/?(?:system|instructions?)>|\[\/?INST\]|<\|endoftext\|>)/i }
];

// Returns findings rather than a boolean, so the caller decides policy.
// Mode "flag" logs and passes through; mode "block" rejects the request.
export function detectInjection(text) {
  if (!text || typeof text !== "string") return [];
  return INJECTION_PATTERNS.filter((p) => p.pattern.test(text)).map((p) => p.name);
}

// --- Message-shape handling ---------------------------------------------

// OpenAI message content is either a string or an array of typed parts
// (`[{type:"text",text:"..."}, {type:"image_url",...}]`). Both guardrails
// used to check `typeof content === "string"` and silently skip anything
// else, so the identical payload passed clean in multimodal form. Anything
// that carries model-visible text has to be walked.
function mapTextParts(content, fn) {
  if (typeof content === "string") return fn(content);
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (typeof part === "string") return fn(part);
    if (part && typeof part === "object" && typeof part.text === "string") {
      return { ...part, text: fn(part.text) };
    }
    return part;
  });
}

function collectText(content) {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const part of content) {
    if (typeof part === "string") out.push(part);
    else if (part && typeof part === "object" && typeof part.text === "string") out.push(part.text);
  }
  return out;
}

// Which roles get scanned for injection.
//
// `system` and `assistant` stay excluded: the system prompt is the
// operator's own text, and flagging it would flag legitimate instructions.
//
// `tool` is now INCLUDED, and this is the substantive change. Tool results
// carry text fetched from web pages, files, APIs and other systems the
// operator does not control — indirect prompt injection is the single
// largest attack surface in agentic use, and it was the one role the
// scanner never looked at. Excluding it was justified by the reasoning for
// excluding `system`, which does not transfer: `tool` content is untrusted
// input, not operator intent.
const SCANNED_ROLES = new Set(["user", "tool", "function"]);

// What the two heuristics actually look for, by name. Reported rather than
// restated in the panel, so a coverage list on screen can never drift from
// the patterns that are really running.
export function guardCoverage() {
  return {
    pii: PII_PATTERNS.map((p) => p.name),
    injection: INJECTION_PATTERNS.map((p) => p.name)
  };
}

export function isScannedRole(role) {
  return SCANNED_ROLES.has(role);
}

// --- Applied to a whole message list ------------------------------------

export function applyGuardrails(messages, options = {}) {
  const { redactPii: doRedact = false, injectionMode = "off" } = options;

  const findings = { pii: [], injection: [] };
  let processed = messages;

  if (doRedact) {
    processed = processed.map((m) => {
      const content = mapTextParts(m.content, (text) => {
        const { text: redacted, found } = redactPii(text);
        findings.pii.push(...found);
        return redacted;
      });
      return content === m.content ? m : { ...m, content };
    });
    findings.pii = [...new Set(findings.pii)];
  }

  if (injectionMode !== "off") {
    for (const m of processed) {
      if (!isScannedRole(m.role)) continue;
      for (const text of collectText(m.content)) {
        findings.injection.push(...detectInjection(text));
      }
    }
    findings.injection = [...new Set(findings.injection)];
  }

  const blocked = injectionMode === "block" && findings.injection.length > 0;

  return { messages: processed, findings, blocked };
}
