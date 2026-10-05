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
      const call = { id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments || "{}" } };
      // Parallel calls arrive as consecutive items, and a chat history needs
      // them on ONE assistant turn: one assistant message per call, each
      // followed by nothing, is rejected by every provider.
      const prev = out[out.length - 1];
      if (prev?.role === "assistant") prev.tool_calls = [...(prev.tool_calls || []), call];
      else out.push({ role: "assistant", content: null, tool_calls: [call] });
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
    tool_choice: toolChoiceOf(body.tool_choice),
    top_p: body.top_p,
    // Responses spells JSON mode as text.format rather than response_format.
    // Dropping it here would put this dialect back where the other three were:
    // accepting the request and answering with prose.
    response_format: responseFormatOf(body.text?.format)
  };
}

// Responses names a forced function flat ({ type, name }); chat nests it.
function toolChoiceOf(choice) {
  if (choice && typeof choice === "object" && choice.type === "function" && choice.name && !choice.function) {
    return { type: "function", function: { name: choice.name } };
  }
  return choice;
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

// Each output item (the text message, every function call) is announced,
// streamed and closed in the order the Responses API defines. Function calls
// used to be dropped from the stream entirely, so Codex, which streams, never
// saw a tool call it had been given.
export async function* toResponsesStream(routerStream, requestedModel) {
  const responseId = `resp_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const newId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const base = { id: responseId, object: "response", model: requestedModel, status: "in_progress" };
  let seq = 0;
  const ev = (type, data) => sse(type, { type, sequence_number: seq++, ...data });
  const items = []; // in output order: { kind, index, id, ...state }
  let message = null; // the text item, once text arrives
  let current = null; // the item being streamed now
  const calls = new Map(); // tool_call index -> item
  let usage = null;
  let finish = null;

  const closeItem = function* (item) {
    if (!item || item.closed) return;
    item.closed = true;
    if (item.kind === "message") {
      yield ev("response.output_text.done", { item_id: item.id, output_index: item.index, content_index: 0, text: item.text });
      yield ev("response.content_part.done", { item_id: item.id, output_index: item.index, content_index: 0, part: { type: "output_text", text: item.text, annotations: [] } });
    } else {
      yield ev("response.function_call_arguments.done", { item_id: item.id, output_index: item.index, arguments: item.arguments });
    }
    yield ev("response.output_item.done", { output_index: item.index, item: finalItem(item) });
  };
  const finalItem = (item) =>
    item.kind === "message"
      ? { type: "message", id: item.id, status: "completed", role: "assistant", content: [{ type: "output_text", text: item.text, annotations: [] }] }
      : { type: "function_call", id: item.id, call_id: item.callId, name: item.name, arguments: item.arguments || "{}", status: "completed" };

  try {
    yield ev("response.created", { response: { ...base, output: [] } });
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
      if (delta.usage) usage = delta.usage;
      const choice = delta.choices?.[0];
      if (choice?.finish_reason) finish = choice.finish_reason;

      const chunk = choice?.delta?.content;
      if (chunk) {
        // Text after a tool call starts a new message item; a closed one
        // takes no more deltas.
        if (!message || message.closed) {
          yield* closeItem(current);
          message = { kind: "message", index: items.length, id: newId("msg"), text: "" };
          items.push(message);
          current = message;
          yield ev("response.output_item.added", { output_index: message.index, item: { type: "message", id: message.id, status: "in_progress", role: "assistant", content: [] } });
          yield ev("response.content_part.added", { item_id: message.id, output_index: message.index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
        }
        message.text += chunk;
        yield ev("response.output_text.delta", { item_id: message.id, output_index: message.index, content_index: 0, delta: chunk });
      }

      for (const tc of choice?.delta?.tool_calls || []) {
        const key = Number.isInteger(tc.index) ? tc.index : tc.id || calls.size;
        let item = calls.get(key);
        if (!item) {
          yield* closeItem(current);
          item = { kind: "call", index: items.length, id: newId("fc"), callId: tc.id || newId("call"), name: tc.function?.name || "", arguments: "" };
          calls.set(key, item);
          items.push(item);
          current = item;
          yield ev("response.output_item.added", { output_index: item.index, item: { type: "function_call", id: item.id, call_id: item.callId, name: item.name, arguments: "", status: "in_progress" } });
        }
        const args = tc.function?.arguments;
        if (args) {
          item.arguments += args;
          yield ev("response.function_call_arguments.delta", { item_id: item.id, output_index: item.index, delta: args });
        }
      }
    }

    for (const item of items) yield* closeItem(item);
    const text = items.filter((i) => i.kind === "message").map((i) => i.text).join("");
    const truncated = finish === "length";
    yield ev(truncated ? "response.incomplete" : "response.completed", {
      response: {
        ...base,
        status: truncated ? "incomplete" : "completed",
        ...(truncated ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
        output: items.map(finalItem),
        output_text: text,
        ...(usage ? { usage: { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0, total_tokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0) } } : {})
      }
    });
  } catch (err) {
    yield sse("response.failed", {
      type: "response.failed", sequence_number: seq++,
      response: { ...base, status: "failed", error: { code: "server_error", message: err.message } }
    });
  }
}
