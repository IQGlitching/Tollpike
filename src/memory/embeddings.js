// Embeddings for vector recall.
//
// There is deliberately NO built-in fallback embedder. A hash-based or
// random-projection "embedding" produces vectors that cluster on spelling
// rather than meaning, and a vector search over those returns confident
// nonsense — worse than returning nothing, because nothing is visibly
// nothing. So when no embedding provider is configured, vector recall reports
// itself unavailable and hybrid recall degrades to keyword-only with the
// reason attached.
//
// Any OpenAI-compatible provider works: the endpoint is baseURL + /embeddings
// and the response shape is data[].embedding. That covers openai, mistral,
// together, deepinfra, nebius, novita and most of the inference hosts in the
// registry. The provider and model are named in settings, never guessed —
// picking an embedding model on someone's behalf spends their money on a
// dimension count they did not choose, and changing it later invalidates every
// vector already stored.

import { getProvider } from "../providers/registry.js";
import { requestJson } from "../providers/http.js";
import { proxyDispatcher } from "../routing/proxy.js";
import { getSettings } from "../storage/settings.js";

export function embeddingConfig() {
  const { memory } = getSettings();
  const providerId = memory.embeddingProvider || null;
  const model = memory.embeddingModel || null;
  if (!providerId || !model) {
    return {
      ok: false,
      reason:
        "No embedding provider configured. Set memory.embeddingProvider and memory.embeddingModel " +
        "(any OpenAI-compatible provider with an /embeddings endpoint)."
    };
  }
  const provider = getProvider(providerId);
  if (!provider) return { ok: false, reason: `Unknown embedding provider "${providerId}"` };
  if (!provider.available) {
    return { ok: false, reason: `No API key set for embedding provider "${providerId}"` };
  }
  return { ok: true, provider, model };
}

/**
 * Embed a batch of strings. Returns { ok, vectors } or { ok: false, reason }.
 *
 * Errors are returned rather than thrown: an embedding provider being down
 * must degrade recall, not fail the chat request that triggered it. A memory
 * subsystem that can take the gateway down is a memory subsystem nobody will
 * leave enabled.
 */
export async function embed(texts) {
  const config = embeddingConfig();
  if (!config.ok) return config;

  const inputs = (Array.isArray(texts) ? texts : [texts]).filter((t) => typeof t === "string" && t.trim());
  if (inputs.length === 0) return { ok: true, vectors: [] };

  const { provider, model } = config;
  try {
    const body = await requestJson(provider.id, `${provider.baseURL}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.connections[0].key}`
      },
      body: JSON.stringify({ model, input: inputs }),
      ...proxyDispatcher(provider.id)
    });

    const vectors = (body.data || [])
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((row) => row.embedding);

    if (vectors.length !== inputs.length) {
      return { ok: false, reason: `embedding provider returned ${vectors.length} vectors for ${inputs.length} inputs` };
    }
    return { ok: true, vectors, dimensions: vectors[0]?.length ?? 0, provider: provider.id, model };
  } catch (err) {
    return { ok: false, reason: `embedding request failed: ${err.message}` };
  }
}
