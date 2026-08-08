// Memory — public API.
//
// Two entry points matter to the request path:
//
//   hydrate(messages, opts)  recall relevant memories and prepend them as a
//                            context block. Returns the messages unchanged
//                            when memory is off or nothing was recalled.
//   ingest(messages, opts)   write this turn to the store, so the next request
//                            can recall it.
//
// OFF BY DEFAULT, and it stays that way. Memory changes the prompt a model
// sees: enabling it silently would mean a gateway that answers differently
// from the request the client actually sent, with no way to tell from the
// client side. `X-Tollpike-Memory-Recalled` is set whenever anything was
// injected, for the same reason.
//
// Ingestion is deliberately narrow. Only user and assistant turns are stored:
//   - system prompts are the operator's, repeated on every request, and would
//     dominate every recall with text the model already has;
//   - tool output is machine text that RTK has already compressed and is the
//     primary indirect-injection vector — persisting it would give an injected
//     payload a way to survive past the conversation it arrived in.

import { remember, keywordSearch, forget, storeStats, pendingEmbedding, markEmbedded, getMemory } from "./store.js";
import { recall, renderRecall, RECALL_MODES } from "./recall.js";
import { embed, embeddingConfig } from "./embeddings.js";
import { upsert, vectorHealth, dropCollection } from "./vector.js";
import { getSettings } from "../storage/settings.js";
import { detectInjection } from "../security/guardrails.js";

const INGESTED_ROLES = new Set(["user", "assistant"]);
const MAX_INGEST_CHARS = 8_000;

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  }
  return "";
}

export function memoryEnabled() {
  return getSettings().memory.enabled === true;
}

/**
 * Store the turns of a request/response pair.
 *
 * Returns a summary rather than throwing: a memory write failing must not fail
 * the completion that already succeeded.
 */
export function ingest(messages, { sessionId = "default", tags = [] } = {}) {
  if (!memoryEnabled()) return { stored: 0, skipped: "memory disabled" };

  let stored = 0;
  let duplicates = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!INGESTED_ROLES.has(message.role)) continue;
    const text = textOf(message.content).trim();
    if (!text) continue;
    const result = remember({
      sessionId,
      role: message.role,
      // A single enormous turn would crowd out everything else in every recall
      // it matched. Truncating keeps the head, which is where the substance of
      // a message almost always is.
      text: text.slice(0, MAX_INGEST_CHARS),
      tags
    });
    if (result?.inserted) stored++;
    else if (result) duplicates++;
  }
  return { stored, duplicates };
}

/**
 * Recall against the newest user turn and prepend a context block.
 *
 * Recalls on the LAST user message rather than the whole conversation: the
 * whole conversation as a query matches everything weakly and nothing
 * strongly, which is how a hybrid recall degrades into a random sample.
 */
export async function hydrate(messages, { sessionId = "default" } = {}) {
  if (!memoryEnabled()) return { messages, recalled: 0 };

  const settings = getSettings().memory;
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return { messages, recalled: 0 };

  const query = textOf(lastUser.content);
  const found = await recall(query, {
    sessionId,
    limit: settings.topK ?? 6,
    mode: RECALL_MODES.includes(settings.recall) ? settings.recall : "hybrid",
    crossSession: settings.crossSession === true
  });

  // Recalled text is prior UNTRUSTED conversation, and it is about to be
  // injected as a `system` message — the one role the injection scanner
  // deliberately never scans, on the grounds that the system prompt is the
  // operator's own text. Memory breaks that assumption: it puts someone else's
  // words into that slot. So the scan happens here instead, and anything that
  // trips it is dropped rather than flagged.
  //
  // Dropping is right even in `flag` mode. Flagging tells the operator after
  // the fact; the memory would still reach the model with system authority,
  // which is precisely the escalation this guard exists to stop. A recalled
  // memory is never load-bearing — losing one costs relevance, not
  // correctness.
  const scanned = found.results.filter((r) => detectInjection(r.text).length === 0);
  const droppedForInjection = found.results.length - scanned.length;

  if (scanned.length === 0) {
    return {
      messages,
      recalled: 0,
      droppedForInjection,
      degraded: found.degraded,
      used: found.used
    };
  }

  const block = renderRecall(scanned);
  // Injected as a `system` message positioned after the operator's own system
  // prompt, so it cannot displace it, and marked as background inside the block
  // itself — see renderRecall for why that labelling matters.
  const systemCount = messages.filter((m) => m.role === "system").length;
  const hydrated = [
    ...messages.slice(0, systemCount),
    { role: "system", content: block },
    ...messages.slice(systemCount)
  ];

  return {
    messages: hydrated,
    // What was actually INJECTED, not what was retrieved. These differ whenever
    // the injection filter above dropped something, and reporting the retrieved
    // count made a silently-filtered recall look like a complete one — the
    // guard fired and nothing downstream could tell. `droppedForInjection` is
    // returned on this path too, not only when everything was dropped.
    recalled: scanned.length,
    retrieved: found.results.length,
    droppedForInjection,
    used: found.used,
    degraded: found.degraded,
    complete: found.complete,
    ids: scanned.map((r) => r.id)
  };
}

/**
 * Embed anything in the store that has no vector yet.
 *
 * Batched and explicit rather than automatic on write: embedding is a paid
 * network call, and doing it inline would put an external dependency on the
 * latency path of every chat request that stores a turn.
 */
export async function syncVectors({ batchSize = 64 } = {}) {
  const config = embeddingConfig();
  if (!config.ok) return { ok: false, reason: config.reason, embedded: 0 };

  const pending = pendingEmbedding(batchSize);
  if (pending.length === 0) return { ok: true, embedded: 0, remaining: 0 };

  const embedded = await embed(pending.map((p) => p.text));
  if (!embedded.ok) return { ok: false, reason: embedded.reason, embedded: 0 };

  const points = pending.map((row, i) => {
    const stored = getMemory(row.id);
    return {
      id: row.id,
      vector: embedded.vectors[i],
      payload: {
        text: row.text,
        role: stored?.role || "user",
        sessionId: stored?.sessionId || "default",
        createdAt: stored?.createdAt || Date.now()
      }
    };
  });

  const written = await upsert(points);
  if (!written.ok) return { ok: false, reason: written.reason, embedded: 0 };

  // Marked only AFTER the vectors are durably in Qdrant. Marking first would
  // leave a memory permanently unsearchable by vector if the upsert failed,
  // with nothing to show it had been skipped.
  markEmbedded(points.map((p) => p.id));
  return {
    ok: true,
    embedded: points.length,
    remaining: pendingEmbedding(1).length > 0 ? "more pending" : 0,
    dimensions: embedded.dimensions
  };
}

export async function memoryStatus() {
  const settings = getSettings().memory;
  const store = storeStats();
  const embedding = embeddingConfig();
  return {
    enabled: settings.enabled === true,
    mode: settings.recall,
    topK: settings.topK,
    crossSession: settings.crossSession === true,
    store,
    // What is CONFIGURED travels either way, not only when it resolves. The
    // panel renders these into editable fields: reporting them only on the
    // happy path meant a provider that was set but unresolvable came back as
    // two empty boxes, and saving anything else on the page wrote those
    // blanks over a configuration the operator never meant to clear.
    embedding: embedding.ok
      ? { ok: true, provider: embedding.provider.id, model: embedding.model }
      : {
          ok: false,
          reason: embedding.reason,
          provider: settings.embeddingProvider ?? null,
          model: settings.embeddingModel ?? null
        },
    vector: await vectorHealth(),
    // What recall can actually do right now, as opposed to what it is set to.
    // "hybrid" configured with no embedding provider is keyword-only, and the
    // panel must say keyword-only.
    effectiveMode:
      settings.recall === "keyword" || !embedding.ok
        ? "keyword"
        : settings.recall
  };
}

export { recall, renderRecall, RECALL_MODES, forget, keywordSearch, remember, dropCollection, storeStats };
