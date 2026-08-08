// Gemini's function-calling format differs from OpenAI's in several ways:
//   1. tools -> [{ functionDeclarations: [...] }] (one wrapper object, not a flat list)
//   2. assistant tool calls -> functionCall parts inside the model's content
//   3. tool results -> functionResponse parts inside a "user"-role content
//   4. Gemini has no call IDs — functions are matched by NAME, so we have to
//      map OpenAI's tool_call_id back to the function name to build responses.
//   5. tool_choice -> toolConfig.functionCallingConfig.mode (AUTO/ANY/NONE)
// All pure functions so they can be tested without touching the network.

export function toGeminiTools(openAiTools) {
  if (!openAiTools || openAiTools.length === 0) return undefined;
  return [
    {
      functionDeclarations: openAiTools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters
      }))
    }
  ];
}

export function toGeminiToolConfig(openAiToolChoice) {
  if (!openAiToolChoice || openAiToolChoice === "auto") return undefined;
  if (openAiToolChoice === "none") {
    return { functionCallingConfig: { mode: "NONE" } };
  }
  if (openAiToolChoice === "required") {
    return { functionCallingConfig: { mode: "ANY" } };
  }
  if (typeof openAiToolChoice === "object" && openAiToolChoice.function?.name) {
    return {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: [openAiToolChoice.function.name]
      }
    };
  }
  return undefined;
}

export function toGeminiContents(messages) {
  // Gemini has no tool-call IDs, so to answer a tool result we need the
  // function NAME that the id referred to. Walk the history once and build
  // that mapping before converting.
  const nameByToolCallId = new Map();
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const call of m.tool_calls) {
        nameByToolCallId.set(call.id, call.function.name);
      }
    }
  }

  const raw = [];

  for (const m of messages) {
    if (m.role === "system") continue; // handled separately as systemInstruction

    if (m.role === "tool") {
      const fnName = nameByToolCallId.get(m.tool_call_id) || "unknown_function";
      let responsePayload;
      try {
        // Gemini wants a structured object; if the tool returned raw text,
        // wrap it rather than sending a bare string.
        responsePayload = typeof m.content === "string" ? JSON.parse(m.content) : m.content;
      } catch {
        responsePayload = { result: m.content };
      }
      raw.push({
        role: "user",
        parts: [{ functionResponse: { name: fnName, response: responsePayload } }]
      });
      continue;
    }

    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      for (const call of m.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          args = {}; // malformed upstream arguments — degrade rather than throw
        }
        parts.push({ functionCall: { name: call.function.name, args } });
      }
      raw.push({ role: "model", parts });
      continue;
    }

    raw.push({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }]
    });
  }

  // Gemini, like Anthropic, wants alternating roles. Merge consecutive
  // same-role entries by concatenating their parts.
  const merged = [];
  for (const c of raw) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === c.role) {
      prev.parts = [...prev.parts, ...c.parts];
    } else {
      merged.push({ ...c, parts: [...c.parts] });
    }
  }

  return merged;
}

// Gemini returns functionCall parts rather than a tool_calls array. Since
// it supplies no call IDs, synthesize deterministic ones so the client can
// correlate its tool results back on the next turn.
export function fromGeminiParts(parts, finishReason) {
  const textParts = [];
  const toolCalls = [];

  for (const part of parts || []) {
    if (part.text) textParts.push(part.text);
    if (part.functionCall) {
      toolCalls.push({
        id: `gemini_${part.functionCall.name}_${toolCalls.length}`,
        type: "function",
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args || {})
        }
      });
    }
  }

  return {
    content: textParts.join("\n") || null,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason: toolCalls.length > 0 ? "tool_calls" : finishReason === "STOP" ? "stop" : "stop"
  };
}
