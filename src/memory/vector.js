// Qdrant vector store, over its REST API.
//
// No SDK. The three calls we need — create collection, upsert points, search —
// are one HTTP request each, and @qdrant/js-client-rest would be a new
// dependency plus its transitive tree for that. The repo's zero-advisory
// dependency posture is worth more than the convenience.
//
// Qdrant is optional. Every function returns { ok: false, reason } rather than
// throwing when it is absent or unreachable, so hybrid recall degrades to
// keyword-only instead of failing the chat request that triggered it.
//
// The collection is created on first use with the dimension count of the first
// vector, because Qdrant needs the size up front and only the configured
// embedding model knows it. Changing embedding model therefore requires a new
// collection: `vectorHealth()` reports the stored dimension so the mismatch is
// visible rather than showing up as uniformly terrible recall.

import { getSettings } from "../storage/settings.js";

const DEFAULT_URL = "http://127.0.0.1:6333";
const REQUEST_TIMEOUT_MS = 10_000;

function config() {
  const { memory } = getSettings();
  return {
    url: (memory.qdrantUrl || process.env.QDRANT_URL || DEFAULT_URL).replace(/\/$/, ""),
    collection: memory.collection || "tollpike-memory",
    apiKey: process.env.QDRANT_API_KEY || null,
    // Explicitly configured means "the operator wants vectors". Falling back to
    // localhost silently would make a connection-refused look like a bug rather
    // than a feature that was never turned on.
    configured: Boolean(memory.qdrantUrl || process.env.QDRANT_URL)
  };
}

async function call(method, pathname, body) {
  const { url, apiKey } = config();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${url}${pathname}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "api-key": apiKey } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!response.ok) {
      return { ok: false, reason: `qdrant ${method} ${pathname} -> HTTP ${response.status}: ${parsed.status?.error || text.slice(0, 200)}` };
    }
    return { ok: true, result: parsed.result };
  } catch (err) {
    const reason =
      err.name === "AbortError"
        ? `qdrant did not respond within ${REQUEST_TIMEOUT_MS}ms`
        : `qdrant unreachable: ${err.message}`;
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

let ensuredFor = null; // `${collection}:${dimensions}` already confirmed present

export async function ensureCollection(dimensions) {
  const { collection } = config();
  const cacheKey = `${collection}:${dimensions}`;
  if (ensuredFor === cacheKey) return { ok: true, created: false };

  const existing = await call("GET", `/collections/${encodeURIComponent(collection)}`);
  if (existing.ok) {
    const size = existing.result?.config?.params?.vectors?.size;
    if (size && size !== dimensions) {
      // Writing 1536-dim vectors into a 768-dim collection is rejected by
      // Qdrant per point, which surfaces as "recall just stopped working".
      // Naming it here makes the actual cause obvious.
      return {
        ok: false,
        reason:
          `collection "${collection}" stores ${size}-dimensional vectors but the configured ` +
          `embedding model produces ${dimensions}. Use a new collection name, or re-embed.`
      };
    }
    ensuredFor = cacheKey;
    return { ok: true, created: false };
  }

  const created = await call("PUT", `/collections/${encodeURIComponent(collection)}`, {
    vectors: { size: dimensions, distance: "Cosine" }
  });
  if (!created.ok) return created;
  ensuredFor = cacheKey;
  return { ok: true, created: true };
}

/**
 * Upsert points. `id` must be the store's integer memory id so a vector hit
 * can be resolved back to its text — the payload carries a copy for display,
 * but the id is what joins the two halves of hybrid recall.
 */
export async function upsert(points) {
  if (!points.length) return { ok: true, upserted: 0 };
  const dimensions = points[0].vector.length;
  const ready = await ensureCollection(dimensions);
  if (!ready.ok) return ready;

  const { collection } = config();
  const result = await call("PUT", `/collections/${encodeURIComponent(collection)}/points?wait=true`, {
    points: points.map((p) => ({ id: p.id, vector: p.vector, payload: p.payload || {} }))
  });
  return result.ok ? { ok: true, upserted: points.length } : result;
}

export async function search(vector, { limit = 10, sessionId = null, crossSession = false } = {}) {
  const { collection } = config();
  const ready = await ensureCollection(vector.length);
  if (!ready.ok) return ready;

  const body = { vector, limit, with_payload: true };
  // Session scoping is applied server-side. Filtering after the fact would
  // return fewer than `limit` results whenever the nearest neighbours belong
  // to another session — and quietly leak their payloads into this process.
  if (sessionId && !crossSession) {
    body.filter = { must: [{ key: "sessionId", match: { value: String(sessionId) } }] };
  }

  const result = await call("POST", `/collections/${encodeURIComponent(collection)}/points/search`, body);
  if (!result.ok) return result;
  return {
    ok: true,
    hits: (result.result || []).map((hit) => ({
      id: hit.id,
      score: hit.score,
      text: hit.payload?.text || "",
      role: hit.payload?.role || "user",
      sessionId: hit.payload?.sessionId || null,
      createdAt: hit.payload?.createdAt || null
    }))
  };
}

export async function dropCollection() {
  const { collection } = config();
  ensuredFor = null;
  return call("DELETE", `/collections/${encodeURIComponent(collection)}`);
}

export async function vectorHealth() {
  const { url, collection, configured, apiKey } = config();
  const info = await call("GET", `/collections/${encodeURIComponent(collection)}`);
  return {
    url,
    collection,
    configured,
    apiKeySet: Boolean(apiKey),
    reachable: info.ok,
    reason: info.ok ? null : info.reason,
    points: info.ok ? info.result?.points_count ?? 0 : null,
    dimensions: info.ok ? info.result?.config?.params?.vectors?.size ?? null : null
  };
}

export function _resetEnsureCache() {
  ensuredFor = null;
}
