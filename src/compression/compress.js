// Compression pipeline. Three layers, stacked, each independently switchable
// from the control panel:
//
//   base     whitespace collapse + consecutive-duplicate lines. Always on,
//            free, effectively lossless. 5-15% on tool-heavy traffic.
//   RTK      structural — tabularize uniform JSON, collapse repeated runs,
//            elide blobs. compression/rtk.js. 40-95% on machine output.
//   Caveman  lossy prose compression — drops grammar the model re-infers.
//            compression/caveman.js. 20-50% on old assistant explanation.
//
// Plus history truncation, which is not compression so much as forgetting:
// everything past `historyWindow` non-system messages is dropped outright.
//
// SCOPE IS THE WHOLE SAFETY ARGUMENT. The lossy layer is aimed at the parts
// of a conversation where exact wording has already stopped mattering:
//
//   system message      base pass only. It is the operator's own text and the
//                       one thing in the request they wrote deliberately.
//   newest user turn    base pass only by default. This is the actual
//                       instruction; paraphrasing it is how a gateway starts
//                       answering a subtly different question.
//   tool results        everything. Untrusted machine output, the largest
//                       share of a coding-agent context, and nothing in it
//                       depends on prose style.
//   older turns         RTK + Caveman. Already acted on; only the gist is
//                       still load-bearing.
//
// `scope: "all"` overrides the newest-turn exemption. It is available because
// some workloads genuinely want it, and documented as the one setting here
// that can change what the model is asked to do.

import { rtk, RTK_DEFAULTS, trimTrailingHorizontal } from "./rtk.js";
import { caveman } from "./caveman.js";
import { estimateTokens } from "../providers/normalize.js";

export const COMPRESSION_DEFAULTS = {
  enabled: true,
  historyWindow: 12,
  rtk: { enabled: true, ...RTK_DEFAULTS },
  caveman: { enabled: true, level: "light", scope: "tools+history" }
};

export const CAVEMAN_LEVELS = ["off", "light", "aggressive"];
export const CAVEMAN_SCOPES = ["tools", "tools+history", "all"];

// Whitespace normalisation, rewritten to run in linear time.
//
// This was `text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")`. The
// first of those is quadratic on input that is mostly spaces and tabs with no
// newline to terminate the run — the engine consumes the run, fails to find
// `\n`, backtracks all of it, moves along one character and does it again.
//
// That was not a theoretical cost. This pass runs on every request inside
// prepare(), BEFORE routing and before any provider is contacted, and
// compression is on by default. 500KB of "  \t  " — comfortably inside the
// 10mb body limit — took minutes of pure CPU, and Node is single-threaded, so
// one unauthenticated POST froze the whole gateway for every other caller.
//
// The rewrite folds the trailing-whitespace strip into the split this function
// already did, and collapses blank runs with a counter instead of `/\n{3,}/g`.
// Same output, no backtracking anywhere.
function basePass(text) {
  const lines = text.split("\n");
  const deduped = [];
  let blankRun = 0;

  for (const raw of lines) {
    const line = trimTrailingHorizontal(raw);

    if (line === "") {
      // `\n{3,}` -> `\n\n` leaves at most one empty line between blocks.
      blankRun++;
      if (blankRun > 1) continue;
      deduped.push(line);
      continue;
    }

    blankRun = 0;
    // Consecutive identical non-blank lines collapse to one.
    if (line === deduped[deduped.length - 1]) continue;
    deduped.push(line);
  }

  return deduped.join("\n");
}

/**
 * Compress one string.
 *
 * Called with no options this is the original base pass and nothing more,
 * which is what every caller predating RTK expects. The additional layers
 * are opt-in per call so scope stays the caller's decision.
 *
 * @param {string} text
 * @param {{ rtk?: boolean|object, caveman?: false|"off"|"light"|"aggressive" }} options
 */
export function compressText(text, options = {}) {
  if (!text || typeof text !== "string") return text;

  let out = text;
  // RTK's `runs` pass supersedes the base dedupe — it keeps the repeat count
  // instead of discarding it — so the two are alternatives, not a stack.
  if (options.rtk) out = rtk(out, options.rtk === true ? {} : options.rtk);
  else out = basePass(out);

  const level = options.caveman === true ? "light" : options.caveman;
  if (level && level !== "off") out = caveman(out, { level });

  return out;
}

// Multimodal content arrives as an array of parts. Only text parts are
// touched; an image part passed through a text compressor would be corrupted.
function compressContent(content, options) {
  if (typeof content === "string") return compressText(content, options);
  if (Array.isArray(content)) {
    return content.map((part) =>
      part && part.type === "text" && typeof part.text === "string"
        ? { ...part, text: compressText(part.text, options) }
        : part
    );
  }
  return content;
}

function contentLength(content) {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    return content.reduce((n, p) => n + (typeof p?.text === "string" ? p.text.length : 0), 0);
  }
  return 0;
}

// `m?.content` rather than `m.content`. A message array is caller-supplied and
// `[null]` is valid JSON: the unguarded version threw a TypeError here, which —
// because Express 4 lets an async handler's rejection escape — terminated the
// process rather than failing the request. The route layer now rejects malformed
// entries with a 400 before reaching this, but a compression pass has no
// business crashing on shapes it can simply measure as zero.
function totalChars(messages) {
  return messages.reduce((n, m) => n + contentLength(m?.content), 0);
}

// Which layers apply to this message, given its role and how recent it is.
function layersFor(message, { isNewest, config }) {
  const rtkOn = config.rtk?.enabled !== false;
  const level = config.caveman?.enabled === false ? "off" : config.caveman?.level || "light";
  const scope = config.caveman?.scope || "tools+history";

  if (message.role === "system") return { rtk: false, caveman: "off" };

  const isToolOutput = message.role === "tool" || message.role === "function";
  if (isToolOutput) {
    return { rtk: rtkOn ? config.rtk : false, caveman: level };
  }

  if (isNewest && scope !== "all") {
    return { rtk: rtkOn ? config.rtk : false, caveman: "off" };
  }

  const cavemanApplies = scope === "all" || scope === "tools+history";
  return { rtk: rtkOn ? config.rtk : false, caveman: cavemanApplies ? level : "off" };
}

/**
 * Compress a message array, reporting what each layer actually saved.
 *
 * The stats exist because a compression ratio nobody can attribute is a
 * number nobody can act on: if 90% of the win is history truncation, tuning
 * the lossy prose layer is wasted effort and carries risk for nothing.
 */
export function compressMessagesWithStats(messages, options = {}) {
  const config = {
    ...COMPRESSION_DEFAULTS,
    ...options,
    rtk: { ...COMPRESSION_DEFAULTS.rtk, ...(options.rtk || {}) },
    caveman: { ...COMPRESSION_DEFAULTS.caveman, ...(options.caveman || {}) }
  };
  const historyWindow = options.historyWindow ?? COMPRESSION_DEFAULTS.historyWindow;

  // Entries are caller-supplied and `[null]` is valid JSON. The route layer
  // rejects malformed messages with a 400 before they get here, but this pass
  // must not be the thing that decides whether the process survives a bad body:
  // an unguarded `m.role` threw a TypeError that Express 4 let escape as an
  // unhandled rejection, which terminated the gateway. Non-objects are carried
  // through untouched rather than dropped — silently removing a message would
  // change the prompt, which is the one thing compression must never do
  // invisibly.
  const input = Array.isArray(messages) ? messages : [];
  const beforeChars = totalChars(input);

  // 1. Forget old turns. System messages are exempt and always survive.
  const systemMsgs = input.filter((m) => m?.role === "system");
  const nonSystem = input.filter((m) => m?.role !== "system");
  const kept = nonSystem.length > historyWindow ? nonSystem.slice(-historyWindow) : nonSystem;
  const droppedMessages = nonSystem.length - kept.length;
  const truncated = [...systemMsgs, ...kept];
  const afterTruncateChars = totalChars(truncated);

  // 2. Structural pass.
  const newestIndex = truncated.length - 1;
  const afterRtk = truncated.map((m, i) => {
    if (!m || typeof m !== "object") return m;
    const layers = layersFor(m, { isNewest: i === newestIndex, config });
    return { ...m, content: compressContent(m.content, { rtk: layers.rtk, caveman: "off" }) };
  });
  const afterRtkChars = totalChars(afterRtk);

  // 3. Lossy prose pass.
  const afterCaveman = afterRtk.map((m, i) => {
    if (!m || typeof m !== "object") return m;
    const layers = layersFor(m, { isNewest: i === newestIndex, config });
    return { ...m, content: compressContent(m.content, { caveman: layers.caveman }) };
  });
  const afterChars = totalChars(afterCaveman);

  const pct = (from, to) => (from > 0 ? Math.max(0, Math.round((1 - to / from) * 100)) : 0);

  return {
    messages: afterCaveman,
    stats: {
      beforeChars,
      afterChars,
      savedPct: pct(beforeChars, afterChars),
      tokensBefore: estimateTokens("x".repeat(beforeChars)),
      tokensAfter: estimateTokens("x".repeat(afterChars)),
      droppedMessages,
      byPass: {
        truncation: { savedChars: beforeChars - afterTruncateChars, savedPct: pct(beforeChars, afterTruncateChars) },
        rtk: { savedChars: afterTruncateChars - afterRtkChars, savedPct: pct(afterTruncateChars, afterRtkChars) },
        caveman: { savedChars: afterRtkChars - afterChars, savedPct: pct(afterRtkChars, afterChars) }
      },
      config: {
        historyWindow,
        rtk: config.rtk.enabled !== false,
        cavemanLevel: config.caveman.enabled === false ? "off" : config.caveman.level,
        cavemanScope: config.caveman.scope
      }
    }
  };
}

/**
 * Back-compatible entry point: returns just the messages.
 *
 * With no layer configuration this applies the base pass and history
 * truncation only, matching the behaviour every caller had before RTK and
 * Caveman existed.
 */
export function compressMessages(messages, options = {}) {
  const config = {
    ...options,
    rtk: { enabled: false, ...(options.rtk || {}) },
    caveman: { enabled: false, ...(options.caveman || {}) }
  };
  return compressMessagesWithStats(messages, config).messages;
}

export function estimateSavingsPct(before, after) {
  if (!before) return 0;
  return Math.round((1 - after / before) * 100);
}
