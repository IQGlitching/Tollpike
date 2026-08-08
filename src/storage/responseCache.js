import crypto from "node:crypto";

// Exact-match response cache. Deliberately NOT semantic/fuzzy matching:
// returning a "similar enough" answer to a different question is a
// correctness bug, not a feature. This only ever returns a response to a
// byte-identical request, which makes it safe to enable by default.
//
// Deterministic requests (temperature 0 or unset) are the sweet spot —
// agent loops that re-send the same system prompt + context repeatedly,
// retried requests, and dev/test iteration all hit this constantly.
// Requests with temperature > 0 are NOT cached, since the caller is
// explicitly asking for varied output.

const store = new Map(); // key -> { response, expiresAt }

let hits = 0;
let misses = 0;

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 500;

export function cacheKey(request, callerId = "anonymous") {
  // Tools and tool_choice affect the answer, so they're part of the key.
  // The provider is NOT part of the key: if the same question was already
  // answered, the answer is reusable regardless of which backend produced
  // it, which is exactly what makes this valuable in a multi-provider gateway.
  //
  // The CALLER is part of the key. With a single shared gateway key that
  // changes nothing today, but the roadmap has per-user auth with separate
  // quotas — and on the day that lands, an unpartitioned cache would start
  // serving one user's response to another user's identical prompt. Cheaper
  // to bind it now than to remember later.
  const payload = JSON.stringify({
    caller: callerId,
    model: request.model,
    messages: request.messages,
    tools: request.tools,
    tool_choice: request.tool_choice,
    max_tokens: request.max_tokens
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export function isCacheable(request) {
  // Only cache deterministic requests. temperature > 0 means the caller
  // wants variation, so serving a repeat would be wrong.
  const temp = request.temperature;
  return temp === undefined || temp === null || temp === 0;
}

export function get(key) {
  const entry = store.get(key);
  if (!entry) {
    misses += 1;
    return null;
  }
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    misses += 1;
    return null;
  }
  // Refresh recency for LRU: re-inserting moves it to the end of Map order.
  store.delete(key);
  store.set(key, entry);
  hits += 1;
  return entry.response;
}

export function set(key, response, ttlMs = DEFAULT_TTL_MS) {
  if (store.size >= MAX_ENTRIES) {
    // Map preserves insertion order, so the first key is the least
    // recently used (get() re-inserts on every hit).
    const oldestKey = store.keys().next().value;
    store.delete(oldestKey);
  }
  store.set(key, { response, expiresAt: Date.now() + ttlMs });
}

export function stats() {
  const total = hits + misses;
  return {
    entries: store.size,
    hits,
    misses,
    hitRatePct: total > 0 ? Math.round((hits / total) * 100) : 0,
    // The two limits that decide what survives. Reported rather than left for
    // the panel to hard-code, so the ceiling on screen is the real ceiling.
    maxEntries: MAX_ENTRIES,
    ttlSeconds: DEFAULT_TTL_MS / 1000
  };
}

export function clear() {
  store.clear();
  hits = 0;
  misses = 0;
}
