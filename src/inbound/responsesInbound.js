// Inbound OpenAI Responses API (`/v1/responses`).
//
// OpenAI's newer format, and what Codex speaks. It differs from chat
// completions in three ways that matter here:
//   1. `input` replaces `messages`, and may be a bare string
//   2. content parts are typed (`input_text` / `output_text`) rather than
//      plain strings
//   3. the reply is an `output[]` array of items, not `choices[]`
//
// Scope: text and function tools, buffered and streamed. The parts of the
// spec this does NOT implement — built-in tools (web_search, file_search),
// stateful `previous_response_id` threading, reasoning items, images — are
// absent rather than faked, so a client asking for them gets nothing back
// instead of something wrong.

import { randomUUID } from "node:crypto";

function inputToMessages(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [];

  const out = [];
  for (const item of input) {
    if (typeof item === "string") { out.push({ role: "user", content: item }); continue; }
    if (!item || typeof item !== "object") continue;

    // Function results come back as their own item type.
    if (item.type === "function_call_output") {
      out.push({ role: "tool", tool_call_id: item.call_id, content: String(item.output ?? "") });
      continue;
    }
    if (item.type === "function_call") {
      out.push({
        role: "assistant",
        content: null,
        tool_calls: [{ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments || "{}" } }]
      });
      continue;
    }

    const content = Array.isArray(item.content)
      ? item.content.map((c) => (typeof c === "string" ? c : c?.text || "")).filter(Boolean).join("\n")
      : item.content;
    if (content !== undefined && content !== null) out.push({ role: item.role || "user", content });
  }
  return out;
}

export function fromResponsesRequest(body = {}) {
  const messages = inputToMessages(body.input);
  if (body.instructions) messages.unshift({ role: "system", content: body.instructions });

  return {
    model: body.model,
    messages,
    temperature: body.temperature,
    max_tokens: body.max_output_tokens,
    // Responses declares function tools flat, without the `function:` wrapper.
    tools: Array.isArray(body.tools)
      ? body.tools
          .filter((t) => t.type === "function")
          .map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.parameters }
          }))
      : undefined,
    tool_choice: body.tool_choice,
    top_p: body.top_p,
    // Responses spells JSON mode as text.format rather than response_format.
    // Dropping it here would put this dialect back where the other three were:
    // accepting the request and answering with prose.
    response_format: responseFormatOf(body.text?.format)
  };
}

// text.format carries the schema flat; chat nests it under json_schema.
function responseFormatOf(format) {
  if (!format || typeof format !== "object") return undefined;
  if (format.type === "json_object") return { type: "json_object" };
  if (format.type === "json_schema") {
    return {
      type: "json_schema",
      json_schema: { name: format.name, schema: format.schema, strict: format.strict }
    };
  }
  // `text` is the default, and anything else is not something we can honour.
  return undefined;
}

export function toResponsesResponse(response, requestedModel) {
  const choice = response.choices?.[0] || {};
  const message = choice.message || {};
  const output = [];

  if (message.content) {
    output.push({
      type: "message",
      id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: message.content, annotations: [] }]
    });
  }
  for (const call of message.tool_calls || []) {
    output.push({
      type: "function_call",
      id: `fc_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      call_id: call.id,
      name: call.function?.name,
      arguments: call.function?.arguments || "{}",
      status: "completed"
    });
  }

  return {
    id: `resp_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: requestedModel || response.model,
    output,
    // Convenience field the SDK exposes as `response.output_text`.
    output_text: message.content || "",
    usage: {
      input_tokens: response.usage?.prompt_tokens ?? 0,
      output_tokens: response.usage?.completion_tokens ?? 0,
      total_tokens: response.usage?.total_tokens ?? 0
    }
  };
}

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export async function* toResponsesStream(routerStream, requestedModel) {
  const responseId = `resp_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const itemId = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const base = { id: responseId, object: "response", model: requestedModel, status: "in_progress" };
  let seq = 0;
  let text = "";
  let started = false;

  try {
    for await (const event of routerStream) {
      if (!started) {
        started = true;
        yield sse("response.created", { type: "response.created", sequence_number: seq++, response: { ...base, output: [] } });
        yield sse("response.output_item.added", {
          type: "response.output_item.added", sequence_number: seq++, output_index: 0,
          item: { type: "message", id: itemId, status: "in_progress", role: "assistant", content: [] }
        });
      }

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

      const chunk = delta.choices?.[0]?.delta?.content;
      if (chunk) {
        text += chunk;
        yield sse("response.output_text.delta", {
          type: "response.output_text.delta", sequence_number: seq++,
          item_id: itemId, output_index: 0, content_index: 0, delta: chunk
        });
      }
    }

    if (!started) {
      yield sse("response.created", { type: "response.created", sequence_number: seq++, response: { ...base, output: [] } });
    }
    yield sse("response.output_text.done", {
      type: "response.output_text.done", sequence_number: seq++,
      item_id: itemId, output_index: 0, content_index: 0, text
    });
    yield sse("response.completed", {
      type: "response.completed", sequence_number: seq++,
      response: {
        ...base, status: "completed",
        output: [{ type: "message", id: itemId, status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
        output_text: text
      }
    });
  } catch (err) {
    yield sse("response.failed", {
      type: "response.failed", sequence_number: seq++,
      response: { ...base, status: "failed", error: { code: "server_error", message: err.message } }
    });
  }
}
