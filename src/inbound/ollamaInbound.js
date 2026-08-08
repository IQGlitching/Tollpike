// Inbound Ollama API.
//
// A surprising number of tools have a hardcoded "point at your local Ollama"
// mode and nothing else. Speaking Ollama's dialect means those tools get
// budget caps, fallback and the ledger without knowing anything changed.
//
// The wire format differs from OpenAI's in one structural way: streaming is
// newline-delimited JSON objects, not SSE frames. No `data:` prefix, no
// blank-line separator, no [DONE] sentinel.

export function fromOllamaRequest(body = {}) {
  return {
    model: body.model,
    messages: (body.messages || []).map((m) => ({ role: m.role, content: m.content })),
    temperature: body.options?.temperature,
    // Ollama calls it num_predict; there is no separate max_tokens.
    max_tokens: body.options?.num_predict,
    tools: body.tools
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
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {})
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
