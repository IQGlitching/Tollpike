// Anthropic's wire format differs from OpenAI's in three ways that matter
// for tool use:
//   1. tool_calls (OpenAI, on assistant messages) vs tool_use content
//      blocks (Anthropic, inline in the message's content array)
//   2. a "tool" role (OpenAI) vs a tool_result content block inside a
//      user message (Anthropic)
//   3. tools[].function.parameters (OpenAI) vs tools[].input_schema (Anthropic)
// Everything here is a pure function so it can be tested without touching
// the network — see the inline tests run during development in the README.

import { SYSTEM_ROLES } from "./normalize.js";

export function toAnthropicMessages(messages) {
  const raw = [];

  for (const m of messages) {
    if (SYSTEM_ROLES.has(m.role)) continue; // handled separately as top-level `system`

    if (m.role === "tool") {
      // OpenAI: {role:"tool", tool_call_id, content}
      // Anthropic: a user message containing a tool_result block
      raw.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.tool_call_id,
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content)
          }
        ]
      });
      continue;
    }

    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      // OpenAI: assistant message with tool_calls[] (arguments as a JSON string)
      // Anthropic: assistant message whose content array has tool_use blocks
      //            (input as a parsed object, not a string)
      const blocks = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const call of m.tool_calls) {
        let input = {};
        try {
          input = JSON.parse(call.function.arguments || "{}");
        } catch {
          input = {}; // malformed arguments from upstream — degrade rather than throw
        }
        blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input });
      }
      raw.push({ role: "assistant", content: blocks });
      continue;
    }

    raw.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
  }

  // Anthropic requires strictly alternating user/assistant roles. A
  // tool-result message (mapped to "user") immediately following another
  // "user"-mapped message — e.g. two tool calls answered back-to-back —
  // would otherwise produce two consecutive same-role messages and a 400
  // from the API. Merge consecutive same-role messages into one, combining
  // their content into a single content-block array.
  const merged = [];
  for (const m of raw) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) {
      const prevBlocks = Array.isArray(prev.content) ? prev.content : [{ type: "text", text: prev.content }];
      const thisBlocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }];
      prev.content = [...prevBlocks, ...thisBlocks];
    } else {
      merged.push({ ...m });
    }
  }

  return merged;
}

export function toAnthropicTools(openAiTools) {
  if (!openAiTools) return undefined;
  return openAiTools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters
  }));
}

export function toAnthropicToolChoice(openAiToolChoice) {
  if (!openAiToolChoice || openAiToolChoice === "auto") return undefined;
  // Anthropic has had a real "none" since 2025. Mapping it to "auto" let the
  // model call tools the caller had just said it must not.
  if (openAiToolChoice === "none") return { type: "none" };
  if (openAiToolChoice === "required") return { type: "any" };
  if (typeof openAiToolChoice === "object" && openAiToolChoice.function?.name) {
    return { type: "tool", name: openAiToolChoice.function.name };
  }
  return undefined;
}

// Converts an Anthropic response's content blocks into OpenAI shape:
// plain text joins into `content`, tool_use blocks become `tool_calls`,
// and finish_reason follows OpenAI's vocabulary ("tool_calls" instead of
// Anthropic's "tool_use").
export function fromAnthropicContent(contentBlocks, anthropicStopReason) {
  const textParts = [];
  const toolCalls = [];

  for (const block of contentBlocks || []) {
    if (block.type === "text") textParts.push(block.text);
    if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input || {}) }
      });
    }
  }

  return {
    content: textParts.join("\n") || null,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason: finishFromAnthropic(anthropicStopReason)
  };
}

// Prompt tokens as billed. Anthropic reports cache writes and cache reads
// apart from input_tokens; counting only input_tokens left a prompt-cached
// conversation looking almost free against the budget cap. They are counted
// here as prompt tokens (as OpenAI's prompt_tokens include cached ones), which
// errs high for cache reads rather than low for everything.
export function anthropicPromptTokens(u) {
  if (!u || u.input_tokens == null) return null;
  return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
}

// Anthropic's stop_reason in OpenAI's vocabulary. "max_tokens" must stay
// "length": mapped to "stop", a reply cut off mid-sentence looked finished and
// no client could tell it to continue.
export function finishFromAnthropic(stopReason) {
  if (stopReason === "tool_use") return "tool_calls";
  if (stopReason === "max_tokens" || stopReason === "model_context_window_exceeded") return "length";
  if (stopReason === "refusal") return "content_filter";
  return "stop";
}
