// Turning stored settings into a guardrail decision, in one place.
//
// This exists because the same policy was being resolved separately per
// surface, and one of them simply never resolved it. `prepare()` in server.js
// guards the four HTTP dialects, but MCP's `completions_chat`, MCP's
// `providers_test` and the A2A `smart-routing` skill all called
// routeChatCompletion directly with caller-supplied text. An operator who
// switched PII redaction on, or set the injection mode to block, got neither
// on any agent-driven request.
//
// That is the same reasoning the rate limiter already applies. server.js
// mounts it on /mcp and /a2a precisely because "completions_chat and the
// smart-routing skill both route real requests, so exempting them would leave
// a way around the only control that stops a runaway agent loop". A guardrail
// that covers the surface a human types into but not the one an agent drives
// is protecting the wrong half: agent traffic is the less supervised of the
// two.
//
// guardrails.js stays free of imports so it remains a pure, trivially
// testable transform. The settings lookup lives here instead.

import { getSettings } from "../storage/settings.js";
import { applyGuardrails } from "./guardrails.js";
import { validateMessages } from "../inbound/validate.js";

/**
 * Apply the operator's configured guardrails to messages about to be routed.
 *
 * Returns the same shape as applyGuardrails: `{ blocked, messages, findings }`.
 * Callers must honour `blocked` rather than routing anyway, or "block" means
 * "log and send it regardless".
 */
export function guardRouted(messages) {
  // Shape first, because a malformed array is not a security question and must
  // never reach an adapter. validateMessages guards the four HTTP dialects but
  // was never applied to MCP or A2A, so `messages: [null]` from an agent sailed
  // through to the provider adapters, where toAnthropicMessages and
  // toGeminiContents both throw on a null entry. The router catches that throw
  // per candidate and hands it to classifyAndRecord, which sees no HTTP status
  // and books it as a provider failure. Three such calls open the circuit
  // breaker on a completely healthy lane and take it out of rotation for
  // everyone. A caller's bad JSON must cost that caller a 400, never a
  // provider's availability.
  const shape = validateMessages(messages);
  if (!shape.ok) throw Object.assign(new Error(shape.error), { status: 400 });

  const settings = getSettings();
  return applyGuardrails(messages, {
    redactPii: settings.redactPii === true,
    injectionMode: settings.injectionMode || "off"
  });
}

/**
 * The message a blocked request should carry back, so every surface refuses
 * in the same words rather than inventing its own.
 */
export function blockedMessage(findings = []) {
  return (
    "Request blocked by the prompt-injection guardrail" +
    (findings.length ? `: ${findings.join(", ")}` : "") +
    ". Set injectionMode to 'flag' in the control panel to log instead of block."
  );
}
