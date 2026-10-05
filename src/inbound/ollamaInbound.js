// Inbound Ollama API.
//
// A surprising number of tools have a hardcoded "point at your local Ollama"
// mode and nothing else. Speaking Ollama's dialect means those tools get
// budget caps, fallback and the ledger without knowing anything changed.
//
// The wire format differs from OpenAI's in one structural way: streaming is
// newline-delimited JSON objects, not SSE frames. No `data:` prefix, no
// blank-line separator, no [DONE] sentinel.

// Ollama's tool calls carry `arguments` as an object and no id; a tool result
// names the tool, not the call. Chat needs string arguments and ids that pair
// each result with its call, so ids are made up here and handed to results in
// order (by name when the result has one). Only role and content were copied
// before, so a tool-using conversation reached the provider with its calls
// and results stripped out.
function fromOllamaMessages(messages = []) {
  const out = [];
  const open = []; // calls not yet answered: { id, name }
  let n = 0;
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const calls = m.tool_calls.map((tc) => {
        const id = tc.id || `call_${n++}`;
        const args = tc.function?.arguments;
        open.push({ id, name: tc.function?.name });
        return { id, type: "function", function: { name: tc.function?.name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) } };
      });
      out.push({ role: "assistant", content: m.content || null, tool_calls: calls });
      continue;
    }
    if (m.role === "tool") {
      const name = m.tool_name || m.name;
      const i = name ? open.findIndex((c) => c.name === name) : 0;
      const call = open.splice(i === -1 ? 0 : i, 1)[0];
      out.push({ role: "tool", tool_call_id: m.tool_call_id || call?.id || `call_${n++}`, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "") });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

// Chat tool calls in Ollama's shape: arguments as an object.
export function toOllamaToolCalls(calls = []) {
  return calls.map((c) => {
    let args = {};
    try {
      args = JSON.parse(c.function?.arguments || "{}");
    } catch {
      args = {};
    }
    return { function: { name: c.function?.name, arguments: args } };
  });
}

export function fromOllamaRequest(body = {}) {
  return {
    model: body.model,
    messages: fromOllamaMessages(body.messages),
    temperature: body.options?.temperature,
    // Ollama calls it num_predict; there is no separate max_tokens.
    max_tokens: body.options?.num_predict,
    tools: body.tools,
    // Ollama nests sampling under options, and its `format: "json"` is the
    // same request as OpenAI's response_format json_object.
    top_p: body.options?.top_p,
    seed: body.options?.seed,
    stop: body.options?.stop,
    // Ollama's format is "json" for plain JSON mode, or a JSON schema object
    // in newer versions.
    response_format:
      body.format === "json"
        ? { type: "json_object" }
        : body.format && typeof body.format === "object"
          ? { type: "json_schema", json_schema: { name: "response", schema: body.format } }
          : undefined
  };
}

export function toOllamaResponse(response, requestedModel) {
  const message = response.choices?.[0]?.message || {};
  return {
    model: requestedModel || response.model,
    created_at: new Date().toISOString(),
    message: {
      role: "assistant",
      content: message.content || "",
      ...(message.tool_calls?.length ? { tool_calls: toOllamaToolCalls(message.tool_calls) } : {})
    },
    done: true,
    done_reason: response.choices?.[0]?.finish_reason === "length" ? "length" : "stop",
    // Ollama reports nanosecond durations. We don't measure the same
    // internals, so only the fields we can answer honestly are populated.
    total_duration: 0,
    prompt_eval_count: response.usage?.prompt_tokens ?? 0,
    eval_count: response.usage?.completion_tokens ?? 0
  };
}

// Ollama's model list. Advertising every configured lane here means an
// Ollama-only client can pick any provider from its normal model dropdown.
export function toOllamaTags(providers) {
  const models = [];
  for (const p of providers) {
    for (const m of p.models) {
      models.push({
        name: `${p.id}/${m}`,
        model: `${p.id}/${m}`,
        modified_at: new Date().toISOString(),
        size: 0,
        digest: "",
        details: { family: p.id, parameter_size: "", quantization_level: "" }
      });
    }
  }
  return { models };
}

const ndjson = (obj) => JSON.stringify(obj) + "\n";

export async function* toOllamaStream(routerStream, requestedModel) {
  let finishReason = "stop";
  let promptTokens = 0;
  let completionTokens = 0;
  // Tool calls arrive in fragments; Ollama streams each call whole, so they
  // are stitched here and sent as one message before the final frame. They
  // used to be dropped from the stream altogether.
  const calls = [];

  try {
    for await (const event of routerStream) {
      let delta = null;
      if (event.type === "chunk") delta = event.chunk;
      else if (event.type === "raw-line") {
        const line = event.line || "";
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (!payload || payload === "[DONE]") continue;
        try { delta = JSON.parse(payload); } catch { continue; }
      }
      if (!delta) continue;

      if (delta.usage) {
        promptTokens = delta.usage.prompt_tokens ?? promptTokens;
        completionTokens = delta.usage.completion_tokens ?? completionTokens;
      }

      const choice = delta.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason === "length" ? "length" : "stop";

      const text = choice.delta?.content;
      if (text) {
        yield ndjson({
          model: requestedModel,
          created_at: new Date().toISOString(),
          message: { role: "assistant", content: text },
          done: false
        });
      }
      for (const tc of choice.delta?.tool_calls || []) {
        const i = Number.isInteger(tc.index) ? tc.index : calls.length;
        const slot = (calls[i] ||= { function: { name: "", arguments: "" } });
        if (tc.function?.name) slot.function.name += tc.function.name;
        if (typeof tc.function?.arguments === "string") slot.function.arguments += tc.function.arguments;
      }
    }

    const whole = calls.filter(Boolean);
    if (whole.length) {
      yield ndjson({
        model: requestedModel,
        created_at: new Date().toISOString(),
        message: { role: "assistant", content: "", tool_calls: toOllamaToolCalls(whole) },
        done: false
      });
    }

    yield ndjson({
      model: requestedModel,
      created_at: new Date().toISOString(),
      message: { role: "assistant", content: "" },
      done: true,
      done_reason: finishReason,
      prompt_eval_count: promptTokens,
      eval_count: completionTokens
    });
  } catch (err) {
    yield ndjson({ model: requestedModel, error: err.message, done: true });
  }
}
