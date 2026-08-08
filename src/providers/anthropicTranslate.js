// Anthropic's wire format differs from OpenAI's in three ways that matter
// for tool use:
//   1. tool_calls (OpenAI, on assistant messages) vs tool_use content
//      blocks (Anthropic, inline in the message's content array)
//   2. a "tool" role (OpenAI) vs a tool_result content block inside a
//      user message (Anthropic)
//   3. tools[].function.parameters (OpenAI) vs tools[].input_schema (Anthropic)
// Everything here is a pure function so it can be tested without touching
// the network — see the inline tests run during development in the README.

export function toAnthropicMessages(messages) {
  const raw = [];

  for (const m of messages) {
    if (m.role === "system") continue; // handled separately as top-level `system`

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
  if (openAiToolChoice === "none") return { type: "auto" }; // Anthropic has no hard "none"; closest is not forcing
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
    finishReason: anthropicStopReason === "tool_use" ? "tool_calls" : "stop"
  };
}
