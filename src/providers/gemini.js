import { normalizedResponse, promptTextOf } from "./normalize.js";
import { requestJson, openStream, readWithStallTimeout } from "./http.js";
import { toGeminiTools, toGeminiToolConfig, toGeminiContents, fromGeminiParts } from "./geminiTranslate.js";
import { proxyDispatcher } from "../routing/proxy.js";
import { wantsJson } from "../routing/sampling.js";

// Gemini takes the API key as a query parameter rather than a header, so
// the model name has to be path-encoded — an unencoded name could otherwise
// inject extra query parameters into the URL alongside the key.
const encodeModel = (model) => encodeURIComponent(String(model));

// Gemini spells the sampling parameters differently and nests them under
// generationConfig. Anything the caller did not send stays absent, so a plain
// request produces the same body it did before.
function generationConfig(request) {
  const cfg = {
    temperature: request.temperature,
    maxOutputTokens: request.max_tokens
  };
  if (request.top_p !== undefined) cfg.topP = request.top_p;
  if (request.seed !== undefined) cfg.seed = request.seed;
  if (request.frequency_penalty !== undefined) cfg.frequencyPenalty = request.frequency_penalty;
  if (request.presence_penalty !== undefined) cfg.presencePenalty = request.presence_penalty;
  if (request.stop !== undefined) {
    cfg.stopSequences = Array.isArray(request.stop) ? request.stop : [request.stop];
  }
  if (wantsJson(request)) {
    cfg.responseMimeType = "application/json";
    // json_schema carries the schema under json_schema.schema; Gemini takes it
    // directly. Without it, responseMimeType alone still guarantees JSON.
    const schema = request.response_format?.json_schema?.schema;
    if (schema) cfg.responseSchema = schema;
  }
  return cfg;
}

export async function callGemini(provider, request, apiKey) {
  const systemMsg = request.messages.find((m) => m.role === "system");
  const contents = toGeminiContents(request.messages);

  const url = `${provider.baseURL}/models/${encodeModel(request.resolvedModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const data = await requestJson(provider.id, url, {
    ...proxyDispatcher(provider.id),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      systemInstruction: systemMsg ? { parts: [{ text: systemMsg.content }] } : undefined,
      tools: toGeminiTools(request.tools),
      toolConfig: toGeminiToolConfig(request.tool_choice),
      generationConfig: generationConfig(request)
    })
  });

  const candidate = data.candidates?.[0];
  const { content, toolCalls, finishReason } = fromGeminiParts(
    candidate?.content?.parts,
    candidate?.finishReason
  );

  return normalizedResponse({
    providerId: provider.id,
    model: request.resolvedModel,
    content,
    toolCalls,
    finishReason,
    usage: {
      prompt_tokens: data.usageMetadata?.promptTokenCount,
      completion_tokens: data.usageMetadata?.candidatesTokenCount
    },
    promptText: promptTextOf(request),
    raw: data
  });
}

// Streaming variant, using Gemini's SSE mode (alt=sse). Each event is a
// full GenerateContentResponse JSON object (not a delta-only patch like
// OpenAI/Anthropic), so we diff against what's already been emitted this
// call to yield only the new text — otherwise the client would see the
// whole response repeated on every chunk.
export async function* streamGemini(provider, request, apiKey) {
  const systemMsg = request.messages.find((m) => m.role === "system");
  const contents = toGeminiContents(request.messages);

  const url = `${provider.baseURL}/models/${encodeModel(request.resolvedModel)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

  const { body, controller } = await openStream(provider.id, url, {
    ...proxyDispatcher(provider.id),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      systemInstruction: systemMsg ? { parts: [{ text: systemMsg.content }] } : undefined,
      tools: toGeminiTools(request.tools),
      toolConfig: toGeminiToolConfig(request.tool_choice),
      generationConfig: generationConfig(request)
    })
  });

  const decoder = new TextDecoder();
  let buffer = "";
  let emittedToolCalls = 0; // assigns sequential OpenAI tool_call indices

  // Gemini repeats cumulative usageMetadata on each SSE event; the last one
  // seen is the authoritative total for the call.
  const usage = { prompt_tokens: null, completion_tokens: null };

  for await (const value of readWithStallTimeout(body, provider.id, controller)) {
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (!payload) continue;

      let event;
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }

      if (event.usageMetadata) {
        usage.prompt_tokens = event.usageMetadata.promptTokenCount ?? usage.prompt_tokens;
        usage.completion_tokens = event.usageMetadata.candidatesTokenCount ?? usage.completion_tokens;
      }

      const parts = event.candidates?.[0]?.content?.parts || [];

      // Gemini's SSE chunks are each a fresh, self-contained set of parts
      // (not cumulative), so text is a direct passthrough of the delta.
      const text = parts.map((p) => p.text).filter(Boolean).join("");
      if (text) {
        yield { choices: [{ delta: { content: text }, index: 0, finish_reason: null }] };
      }

      // Gemini streams a functionCall as one complete part rather than
      // incremental JSON fragments, so each one becomes a single fully
      // formed OpenAI tool_call delta (id + name + complete arguments)
      // instead of the scaffold-then-append sequence Anthropic needs.
      for (const part of parts) {
        if (!part.functionCall) continue;
        const toolCallIndex = emittedToolCalls++;
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: toolCallIndex,
                    id: `gemini_${part.functionCall.name}_${toolCallIndex}`,
                    type: "function",
                    function: {
                      name: part.functionCall.name,
                      arguments: JSON.stringify(part.functionCall.args || {})
                    }
                  }
                ]
              },
              index: 0,
              finish_reason: null
            }
          ]
        };
      }

      if (event.candidates?.[0]?.finishReason) {
        yield {
          choices: [
            { delta: {}, index: 0, finish_reason: emittedToolCalls > 0 ? "tool_calls" : "stop" }
          ]
        };
      }
    }
  }

  // Internal frame: consumed by the router for cost accounting, never
  // forwarded to the client.
  if (usage.prompt_tokens !== null || usage.completion_tokens !== null) {
    yield { __usage: usage };
  }
}
