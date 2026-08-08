// Shared request-shape validation for every inbound dialect.
//
// The existing per-route checks confirmed `Array.isArray(messages)` and stopped
// there, which accepts `[null]`, `[42]` and `[[]]` — all valid JSON, none of
// them messages. Those reached the compression pass and threw on `m.role`, and
// because Express 4 lets an async handler's rejection escape as an unhandled
// rejection, the throw terminated the process. One unauthenticated request with
// a three-character body took the gateway down for everyone.
//
// server.js now wraps handlers so a throw becomes a 500 rather than an exit, and
// the compression pass tolerates odd entries. This is the third layer and the
// one that produces the RIGHT answer: a 400 naming what was wrong, before any
// work is done. Defence in depth is the point — each layer alone would have
// prevented the outage, and the crash happened because there were none.
//
// Deliberately permissive about everything except structure. Content may be a
// string, an array of typed parts, null, or absent; roles are not restricted to
// a known set because dialects disagree about which exist and a gateway that
// rejects a role its upstream would have accepted is a broken gateway.

const MAX_MESSAGES = 10_000;

/**
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateMessages(messages) {
  if (!Array.isArray(messages)) {
    return { ok: false, error: "messages must be an array" };
  }
  if (messages.length > MAX_MESSAGES) {
    return { ok: false, error: `messages must contain at most ${MAX_MESSAGES} entries` };
  }

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      return { ok: false, error: `messages[${i}] must be an object` };
    }
    if (typeof message.role !== "string" || message.role === "") {
      return { ok: false, error: `messages[${i}].role must be a non-empty string` };
    }
  }

  return { ok: true };
}
