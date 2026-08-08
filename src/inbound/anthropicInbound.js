// Inbound Anthropic Messages API.
//
// `providers/anthropicTranslate.js` converts OUR requests into Anthropic's
// wire format on the way out. This is the mirror: it accepts a request
// already written in Anthropic's format and converts it inward, so the
// router can send it to any provider at all.
//
// That direction is what lets Claude Code and Cline talk to this gateway.
// They only speak `/v1/messages`; without this they get a 404 no matter how
// many providers are configured. The gap was never provider coverage — it
// was that the gateway understood one inbound dialect.

import { randomUUID } from "node:crypto";

// --- Request: Anthropic -> internal (OpenAI-shaped) ---------------------

// Anthropic allows `system` as a plain string or an array of content blocks.
function systemToText(system) {
  if (!system) return null;
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system.map((b) => (typeof b === "string" ? b : b?.text || "")).filter(Boolean).join("\n") || null;
  }
  return null;
}

function blocksToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (b?.type === "text" ? b.text : typeof b === "string" ? b : "")).filter(Boolean).join("\n");
}

// Anthropic packs tool calls and tool results INSIDE the content array;
// OpenAI hangs them off the message as `tool_calls` and a `tool` role. This
// unpacks one message into however many OpenAI messages it implies.
export function fromAnthropicMessages(messages = []) {
  const out = [];

  for (const m of messages) {
    const content = m?.content;

    if (typeof content === "string") {
      out.push({ role: m.role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    if (m.role === "assistant") {
      const text = blocksToText(content);
      const toolUses = content.filter((b) => b?.type === "tool_use");
      const msg = { role: "assistant", content: text || null };
      if (toolUses.length) {
        msg.tool_calls = toolUses.map((b) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) }
        }));
      }
      out.push(msg);
      continue;
    }

    // A user turn may carry tool_result blocks, ordinary text, or both.
    // Each tool_result becomes its own OpenAI `tool` message.
    const toolResults = content.filter((b) => b?.type === "tool_result");
    for (const tr of toolResults) {
      out.push({
        role: "tool",
        tool_call_id: tr.tool_use_id,
        content: typeof tr.content === "string" ? tr.content : blocksToText(tr.content) || JSON.stringify(tr.content ?? "")
      });
    }
    const text = blocksToText(content);
    if (text) out.push({ role: "user", content: text });
  }

  return out;
}

export function fromAnthropicTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema }
  }));
}

export function fromAnthropicToolChoice(choice) {
  if (!choice) return undefined;
  if (choice.type === "any") return "required";
  if (choice.type === "auto") return "auto";
  if (choice.type === "tool" && choice.name) return { type: "function", function: { name: choice.name } };
  return undefined;
}

export function fromAnthropicRequest(body = {}) {
  const messages = fromAnthropicMessages(body.messages);
  const system = systemToText(body.system);
  if (system) messages.unshift({ role: "system", content: system });

  return {
    model: body.model,
    messages,
    temperature: body.temperature,
    max_tokens: body.max_tokens,
    tools: fromAnthropicTools(body.tools),
    tool_choice: fromAnthropicToolChoice(body.tool_choice)
  };
}

// --- Response: internal (OpenAI-shaped) -> Anthropic ---------------------

const stopReasonFor = (finish) =>
  finish === "tool_calls" ? "tool_use" : finish === "length" ? "max_tokens" : "end_turn";

export function toAnthropicResponse(response, requestedModel) {
  const choice = response.choices?.[0] || {};
  const message = choice.message || {};
  const blocks = [];

  if (message.content) blocks.push({ type: "text", text: message.content });
  for (const call of message.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(call.function?.arguments || "{}");
    } catch {
      input = {}; // malformed arguments upstream — degrade rather than throw
    }
    blocks.push({ type: "tool_use", id: call.id || `toolu_${randomUUID().slice(0, 8)}`, name: call.function?.name, input });
  }

  return {
    id: response.id?.startsWith("msg_") ? response.id : `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "message",
    role: "assistant",
    model: requestedModel || response.model,
    content: blocks,
    stop_reason: stopReasonFor(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.prompt_tokens ?? 0,
      output_tokens: response.usage?.completion_tokens ?? 0
    }
  };
}

// --- Streaming ----------------------------------------------------------

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// The router yields two shapes: `raw-line` (verbatim OpenAI SSE text, from
// the passthrough adapter) and `chunk` (already-normalized delta objects).
// Both are flattened to OpenAI-shaped deltas here so the Anthropic encoder
// below only has one thing to think about.
function deltaFromRouterEvent(event) {
  if (event.type === "chunk") return event.chunk;
  if (event.type !== "raw-line") return null;
  const line = event.line || "";
  if (!line.startsWith("data: ")) return null;
  const payload = line.slice(6).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

// Emits an Anthropic SSE stream. Anthropic's protocol is block-structured —
// every piece of content is opened, streamed and closed — where OpenAI's is
// a flat sequence of deltas, so this has to track which block is currently
// open and close it before opening another.
export async function* toAnthropicStream(routerStream, requestedModel) {
  const messageId = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  let started = false;
  let textOpen = false;
  let blockIndex = 0;
  let stopReason = "end_turn";
  let outputTokens = 0;
  let inputTokens = 0;
  // OpenAI tool_call index -> our content-block index
  const toolBlocks = new Map();

  const start = () => {
    started = true;
    return sse("message_start", {
      type: "message_start",
      message: {
        id: messageId, type: "message", role: "assistant", model: requestedModel,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });
  };

  try {
    for await (const event of routerStream) {
      if (!started) yield start();

      const delta = deltaFromRouterEvent(event);
      if (!delta) continue;

      if (delta.usage) {
        inputTokens = delta.usage.prompt_tokens ?? inputTokens;
        outputTokens = delta.usage.completion_tokens ?? outputTokens;
      }

      const choice = delta.choices?.[0];
      if (!choice) continue;

      const text = choice.delta?.content;
      if (text) {
        if (!textOpen) {
          yield sse("content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } });
          textOpen = true;
        }
        outputTokens += 1; // rough; replaced by the provider's count if it sends one
        yield sse("content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text } });
      }

      for (const call of choice.delta?.tool_calls || []) {
        // A tool call means the text block (if any) is finished.
        if (textOpen) {
          yield sse("content_block_stop", { type: "content_block_stop", index: blockIndex });
          textOpen = false;
          blockIndex += 1;
        }
        if (!toolBlocks.has(call.index)) {
          toolBlocks.set(call.index, blockIndex);
          yield sse("content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: { type: "tool_use", id: call.id || `toolu_${randomUUID().slice(0, 8)}`, name: call.function?.name || "", input: {} }
          });
        }
        const args = call.function?.arguments;
        if (args) {
          yield sse("content_block_delta", {
            type: "content_block_delta",
            index: toolBlocks.get(call.index),
            delta: { type: "input_json_delta", partial_json: args }
          });
        }
      }

      if (choice.finish_reason) stopReason = stopReasonFor(choice.finish_reason);
    }

    if (!started) yield start();
    if (textOpen || toolBlocks.size) {
      yield sse("content_block_stop", { type: "content_block_stop", index: blockIndex });
    }
    yield sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens }
    });
    yield sse("message_stop", { type: "message_stop" });
  } catch (err) {
    // Once bytes are on the wire an HTTP status is no longer available, so
    // the failure has to be reported inside the stream itself.
    yield sse("error", { type: "error", error: { type: "api_error", message: err.message } });
  }
}
