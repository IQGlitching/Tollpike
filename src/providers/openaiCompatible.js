import { normalizedResponse, promptTextOf } from "./normalize.js";
import { proxyDispatcher } from "../routing/proxy.js";
import { pickSampling } from "../routing/sampling.js";
import { requestJson, openStream, ProviderError, UpstreamTimeoutError } from "./http.js";

// Re-exported so existing importers (and tests) keep working now that the
// error types live in the shared transport module.
export { ProviderError, UpstreamTimeoutError };

// Almost every "OpenAI-compatible" provider accepts the exact same request
// body and returns the exact same response shape. This one adapter is what
// makes broad provider coverage cheap: adding provider #12 is a config
// entry, not a new adapter.
export async function callOpenAICompatible(provider, request, apiKey) {
  const url = `${provider.baseURL}/chat/completions`;

  const data = await requestJson(provider.id, url, {
    ...proxyDispatcher(provider.id),
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: request.resolvedModel,
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.max_tokens,
      tools: request.tools,
      tool_choice: request.tool_choice,
      ...pickSampling(request)
    })
  });

  const choice = data.choices?.[0];

  return normalizedResponse({
    id: data.id,
    providerId: provider.id,
    model: request.resolvedModel,
    content: choice?.message?.content ?? "",
    toolCalls: choice?.message?.tool_calls,
    finishReason: choice?.finish_reason,
    usage: {
      prompt_tokens: data.usage?.prompt_tokens,
      completion_tokens: data.usage?.completion_tokens
    },
    promptText: promptTextOf(request),
    raw: data
  });
}

// Streaming variant. Because the wire format IS OpenAI's SSE format already,
// this is a genuine passthrough — no translation needed, which is exactly
// why the "one adapter, many providers" bet pays off. Connection is opened
// and checked for res.ok BEFORE returning, so a failure here still lets the
// router fall back to the next candidate without having written anything
// to the client yet.
export async function streamOpenAICompatible(provider, request, apiKey) {
  return openStream(provider.id, `${provider.baseURL}/chat/completions`, {
    ...proxyDispatcher(provider.id),
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: request.resolvedModel,
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.max_tokens,
      tools: request.tools,
      tool_choice: request.tool_choice,
      // Standard OpenAI chat fields, and only the ones the caller actually
      // sent, so a request that uses none of them produces the same body as
      // before. That matters here: the note below is about not adding fields
      // nobody asked for.
      ...pickSampling(request),
      stream: true
      // Deliberately NOT sending `stream_options: {include_usage: true}`.
      // It would give exact streamed spend, but strict providers reject
      // unknown body fields, and none of the 30 openai-compatible entries
      // here have been exercised against a live API. The router reads a
      // usage frame when a provider volunteers one instead.
    })
  });
}
