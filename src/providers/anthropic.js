import { normalizedResponse, promptTextOf } from "./normalize.js";
import { requestJson, openStream, readWithStallTimeout } from "./http.js";
import { toAnthropicMessages, toAnthropicTools, toAnthropicToolChoice, fromAnthropicContent } from "./anthropicTranslate.js";
import { proxyDispatcher } from "../routing/proxy.js";

// The two sampling parameters the Messages API actually has. The rest of the
// list this gateway carries has no equivalent here: Anthropic has no
// response_format, seed, logit_bias or frequency/presence penalties, and the
// way to get JSON out of Claude is a tool with the schema you want. Mapping
// them onto something approximate would be emulating a capability rather than
// reporting it, so they are left off and documented as unsupported.
function anthropicSampling(request) {
  const out = {};
  if (request.top_p !== undefined) out.top_p = request.top_p;
  if (request.stop !== undefined) {
    out.stop_sequences = Array.isArray(request.stop) ? request.stop : [request.stop];
  }
  return out;
}

export async function callAnthropic(provider, request, apiKey) {
  const systemMsg = request.messages.find((m) => m.role === "system");

  const data = await requestJson(provider.id, `${provider.baseURL}/messages`, {
    ...proxyDispatcher(provider.id),
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: request.resolvedModel,
      system: systemMsg?.content,
      messages: toAnthropicMessages(request.messages),
      tools: toAnthropicTools(request.tools),
      tool_choice: toAnthropicToolChoice(request.tool_choice),
      max_tokens: request.max_tokens || 1024,
      temperature: request.temperature,
      ...anthropicSampling(request)
    })
  });

  const { content, toolCalls, finishReason } = fromAnthropicContent(data.content, data.stop_reason);

  return normalizedResponse({
    id: data.id,
    providerId: provider.id,
    model: request.resolvedModel,
    content,
    toolCalls,
    finishReason,
    usage: {
      prompt_tokens: data.usage?.input_tokens,
      completion_tokens: data.usage?.output_tokens
    },
    promptText: promptTextOf(request),
    raw: data
  });
}

// Streaming variant. Anthropic's SSE events (message_start,
// content_block_delta, message_stop, ...) have a different shape than
// OpenAI's — this async generator translates each event into an
// OpenAI-style chunk so the server layer can treat every provider's
// stream identically, including tool-call deltas. Connection + status is
// validated before any translation starts, same fallback-safety guarantee
// as the OpenAI adapter.
export async function* streamAnthropic(provider, request, apiKey) {
  const systemMsg = request.messages.find((m) => m.role === "system");

  const { body, controller } = await openStream(provider.id, `${provider.baseURL}/messages`, {
    ...proxyDispatcher(provider.id),
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: request.resolvedModel,
      system: systemMsg?.content,
      messages: toAnthropicMessages(request.messages),
      tools: toAnthropicTools(request.tools),
      tool_choice: toAnthropicToolChoice(request.tool_choice),
      max_tokens: request.max_tokens || 1024,
      temperature: request.temperature,
      ...anthropicSampling(request),
      stream: true
    })
  });

  const decoder = new TextDecoder();
  let buffer = "";

  // Anthropic identifies content blocks by index within the message;
  // OpenAI identifies tool_calls by index within its own tool_calls array.
  // Since Anthropic's content-block indices already start at 0 and
  // increment per block, and we only care about the tool_use ones for
  // this mapping, track which content-block indices are tool calls and
  // assign them sequential OpenAI tool_call indices as they appear.
  const toolCallIndexByBlockIndex = new Map();

  // Anthropic reports real token counts in message_start / message_delta.
  // Captured here so streamed spend is the provider's own number rather
  // than a character-count estimate.
  const usage = { prompt_tokens: null, completion_tokens: null };

  for await (const value of readWithStallTimeout(body, provider.id, controller)) {
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep the partial last line for next chunk

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

      if (event.type === "message_start" && event.message?.usage) {
        usage.prompt_tokens = event.message.usage.input_tokens ?? null;
        usage.completion_tokens = event.message.usage.output_tokens ?? null;
      }

      if (event.type === "message_delta" && event.usage) {
        // message_delta carries the running output total.
        usage.completion_tokens = event.usage.output_tokens ?? usage.completion_tokens;
      }

      if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
        const toolCallIndex = toolCallIndexByBlockIndex.size;
        toolCallIndexByBlockIndex.set(event.index, toolCallIndex);
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: toolCallIndex,
                    id: event.content_block.id,
                    type: "function",
                    function: { name: event.content_block.name, arguments: "" }
                  }
                ]
              },
              index: 0,
              finish_reason: null
            }
          ]
        };
      }

      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        yield {
          choices: [{ delta: { content: event.delta.text }, index: 0, finish_reason: null }]
        };
      }

      if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
        const toolCallIndex = toolCallIndexByBlockIndex.get(event.index);
        if (toolCallIndex !== undefined) {
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: toolCallIndex, function: { arguments: event.delta.partial_json } }]
                },
                index: 0,
                finish_reason: null
              }
            ]
          };
        }
      }

      if (event.type === "message_delta" && event.delta?.stop_reason) {
        const finishReason = event.delta.stop_reason === "tool_use" ? "tool_calls" : "stop";
        yield { choices: [{ delta: {}, index: 0, finish_reason: finishReason }] };
      }
    }
  }

  // Internal frame: consumed by the router for cost accounting and never
  // forwarded to the client, so the SSE the caller sees stays OpenAI-shaped.
  if (usage.prompt_tokens !== null || usage.completion_tokens !== null) {
    yield { __usage: usage };
  }
}
