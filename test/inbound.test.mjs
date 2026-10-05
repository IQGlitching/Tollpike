import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  fromAnthropicMessages, fromAnthropicRequest, fromAnthropicTools,
  fromAnthropicToolChoice, toAnthropicResponse
} from "../src/inbound/anthropicInbound.js";
import { fromOllamaRequest, toOllamaResponse, toOllamaTags } from "../src/inbound/ollamaInbound.js";
import { fromResponsesRequest, toResponsesResponse } from "../src/inbound/responsesInbound.js";
import { rewritePathToken } from "../src/middleware/pathToken.js";

// The inbound translators are pure, so the fiddly parts — tool calls,
// content blocks, role restructuring — are testable without a network or a
// provider. Same reasoning as the outbound *Translate modules.

describe("inbound: Anthropic messages", () => {
  test("accepts plain string content", () => {
    assert.deepEqual(
      fromAnthropicMessages([{ role: "user", content: "hi" }]),
      [{ role: "user", content: "hi" }]
    );
  });

  test("flattens text content blocks", () => {
    assert.deepEqual(
      fromAnthropicMessages([{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }]),
      [{ role: "user", content: "a\nb" }]
    );
  });

  test("converts tool_use blocks into OpenAI tool_calls", () => {
    const out = fromAnthropicMessages([
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Ghent" } }] }
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].role, "assistant");
    assert.equal(out[0].tool_calls[0].id, "toolu_1");
    assert.equal(out[0].tool_calls[0].function.name, "get_weather");
    assert.deepEqual(JSON.parse(out[0].tool_calls[0].function.arguments), { city: "Ghent" });
  });

  test("converts tool_result blocks into a tool-role message", () => {
    const out = fromAnthropicMessages([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "17C" }] }
    ]);
    assert.deepEqual(out, [{ role: "tool", tool_call_id: "toolu_1", content: "17C" }]);
  });

  test("splits a user turn carrying both a tool result and text", () => {
    const out = fromAnthropicMessages([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "17C" }, { type: "text", text: "and now?" }] }
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0].role, "tool");
    assert.deepEqual(out[1], { role: "user", content: "and now?" });
  });

  test("hoists system, as a string or as blocks", () => {
    for (const system of ["be terse", [{ type: "text", text: "be terse" }]]) {
      const r = fromAnthropicRequest({ model: "m", system, messages: [{ role: "user", content: "hi" }] });
      assert.deepEqual(r.messages[0], { role: "system", content: "be terse" });
    }
  });

  test("maps tools and tool_choice both ways round", () => {
    assert.deepEqual(
      fromAnthropicTools([{ name: "f", description: "d", input_schema: { type: "object" } }]),
      [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } }]
    );
    assert.equal(fromAnthropicToolChoice({ type: "any" }), "required");
    assert.equal(fromAnthropicToolChoice({ type: "auto" }), "auto");
    assert.deepEqual(fromAnthropicToolChoice({ type: "tool", name: "f" }), { type: "function", function: { name: "f" } });
  });

  test("renders a response back into Anthropic shape", () => {
    const r = toAnthropicResponse({
      choices: [{ message: { content: "hello", tool_calls: [{ id: "c1", function: { name: "f", arguments: '{"a":1}' } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 4 }
    }, "claude-sonnet-4-6");

    assert.equal(r.type, "message");
    assert.equal(r.model, "claude-sonnet-4-6");
    assert.equal(r.stop_reason, "tool_use", "OpenAI 'tool_calls' maps to Anthropic 'tool_use'");
    assert.deepEqual(r.content[0], { type: "text", text: "hello" });
    assert.equal(r.content[1].type, "tool_use");
    assert.deepEqual(r.content[1].input, { a: 1 }, "arguments string becomes a parsed object");
    assert.deepEqual(r.usage, { input_tokens: 10, output_tokens: 4 });
  });

  test("survives malformed tool arguments rather than throwing", () => {
    const r = toAnthropicResponse({
      choices: [{ message: { tool_calls: [{ id: "c1", function: { name: "f", arguments: "{not json" } }] }, finish_reason: "tool_calls" }]
    }, "m");
    assert.deepEqual(r.content[0].input, {});
  });

  test("maps length-limited finishes to max_tokens", () => {
    const r = toAnthropicResponse({ choices: [{ message: { content: "x" }, finish_reason: "length" }] }, "m");
    assert.equal(r.stop_reason, "max_tokens");
  });
});

describe("inbound: Ollama", () => {
  test("reads options.temperature and options.num_predict", () => {
    const r = fromOllamaRequest({ model: "m", messages: [{ role: "user", content: "hi" }], options: { temperature: 0.2, num_predict: 64 } });
    assert.equal(r.temperature, 0.2);
    assert.equal(r.max_tokens, 64, "Ollama's num_predict is its max_tokens");
  });

  test("renders a response in Ollama shape", () => {
    const r = toOllamaResponse({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } }, "m");
    assert.equal(r.done, true);
    assert.equal(r.message.content, "hi");
    assert.equal(r.prompt_eval_count, 3);
  });

  test("advertises every configured lane as a taggable model", () => {
    const tags = toOllamaTags([{ id: "groq", models: ["a", "b"] }, { id: "openai", models: ["c"] }]);
    assert.deepEqual(tags.models.map((m) => m.name), ["groq/a", "groq/b", "openai/c"]);
  });
});

describe("inbound: OpenAI Responses", () => {
  test("accepts a bare string input", () => {
    assert.deepEqual(fromResponsesRequest({ model: "m", input: "hi" }).messages, [{ role: "user", content: "hi" }]);
  });

  test("flattens typed content parts", () => {
    const r = fromResponsesRequest({ model: "m", input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] });
    assert.deepEqual(r.messages, [{ role: "user", content: "hi" }]);
  });

  test("hoists instructions to a system message", () => {
    const r = fromResponsesRequest({ model: "m", input: "hi", instructions: "be terse" });
    assert.deepEqual(r.messages[0], { role: "system", content: "be terse" });
  });

  test("round-trips function calls and their outputs", () => {
    const r = fromResponsesRequest({
      model: "m",
      input: [
        { type: "function_call", call_id: "c1", name: "f", arguments: '{"a":1}' },
        { type: "function_call_output", call_id: "c1", output: "42" }
      ]
    });
    assert.equal(r.messages[0].tool_calls[0].id, "c1");
    assert.deepEqual(r.messages[1], { role: "tool", tool_call_id: "c1", content: "42" });
  });

  test("maps max_output_tokens and flat function tools", () => {
    const r = fromResponsesRequest({
      model: "m", input: "hi", max_output_tokens: 99,
      tools: [{ type: "function", name: "f", description: "d", parameters: { type: "object" } }]
    });
    assert.equal(r.max_tokens, 99);
    assert.deepEqual(r.tools[0], { type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } });
  });

  test("renders output[] plus the output_text convenience field", () => {
    const r = toResponsesResponse({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }, "m");
    assert.equal(r.object, "response");
    assert.equal(r.status, "completed");
    assert.equal(r.output[0].content[0].type, "output_text");
    assert.equal(r.output_text, "hi");
    assert.deepEqual(r.usage, { input_tokens: 2, output_tokens: 1, total_tokens: 3 });
  });
});

describe("inbound: path-token aliases", () => {
  test("extracts the token and normalises the path", () => {
    assert.deepEqual(rewritePathToken("/vscode/tpk_abc/chat/completions"), { token: "tpk_abc", path: "/v1/chat/completions" });
    assert.deepEqual(rewritePathToken("/key/tpk_abc/v1/messages"), { token: "tpk_abc", path: "/v1/messages" });
    assert.deepEqual(rewritePathToken("/t/tpk_abc/v1/chat/completions"), { token: "tpk_abc", path: "/v1/chat/completions" });
  });

  test("ignores paths that aren't aliases", () => {
    for (const url of ["/v1/chat/completions", "/panel/index.html", "/vscode", "/nope/tpk_abc/x"]) {
      assert.equal(rewritePathToken(url), null, url);
    }
  });

  test("url-decodes the token", () => {
    assert.equal(rewritePathToken("/vscode/tpk%5Fabc/chat/completions").token, "tpk_abc");
  });

  test("the key leaves originalUrl too, so auth sees a model surface and no log can hold it", async () => {
    const { pathToken } = await import("../src/middleware/pathToken.js");
    const { isModelSurface } = await import("../src/middleware/auth.js");
    const was = process.env.ALLOW_PATH_TOKEN;
    process.env.ALLOW_PATH_TOKEN = "true";
    try {
      const req = { url: "/key/tpa_secretvalue/v1/chat/completions", originalUrl: "/key/tpa_secretvalue/v1/chat/completions", headers: {} };
      pathToken(req, {}, () => {});
      assert.equal(req.originalUrl, "/v1/chat/completions");
      assert.ok(!JSON.stringify({ url: req.url, originalUrl: req.originalUrl }).includes("tpa_secretvalue"));
      assert.equal(isModelSurface(req), true);
    } finally {
      if (was === undefined) delete process.env.ALLOW_PATH_TOKEN;
      else process.env.ALLOW_PATH_TOKEN = was;
    }
  });
});

// Each dialect spells the sampling parameters its own way. They were all being
// dropped in translation, so a caller asking any of these three surfaces for
// JSON got prose back with a 200. The chat dialect passes them through by name.
describe("inbound: every dialect carries its sampling parameters", () => {
  const sampling = (r) => ({
    top_p: r.top_p, stop: r.stop, seed: r.seed, response_format: r.response_format
  });

  test("Anthropic: stop_sequences and top_p", () => {
    const r = fromAnthropicRequest({ model: "m", messages: [], top_p: 0.9, stop_sequences: ["END"] });
    assert.equal(r.top_p, 0.9);
    assert.deepEqual(r.stop, ["END"]);
  });

  test("Ollama: options.* and format", () => {
    const r = fromOllamaRequest({
      model: "m", messages: [], format: "json",
      options: { top_p: 0.2, seed: 5, stop: ["X"] }
    });
    assert.equal(r.top_p, 0.2);
    assert.equal(r.seed, 5);
    assert.deepEqual(r.stop, ["X"]);
    assert.deepEqual(r.response_format, { type: "json_object" });
  });

  test("Ollama: a schema object is JSON mode too", () => {
    const r = fromOllamaRequest({ model: "m", messages: [], format: { type: "object" } });
    assert.equal(r.response_format.type, "json_schema");
    assert.deepEqual(r.response_format.json_schema.schema, { type: "object" });
  });

  test("Responses: text.format is this dialect's response_format", () => {
    const obj = fromResponsesRequest({ model: "m", input: "hi", top_p: 0.4, text: { format: { type: "json_object" } } });
    assert.equal(obj.top_p, 0.4);
    assert.deepEqual(obj.response_format, { type: "json_object" });

    const schema = fromResponsesRequest({
      model: "m", input: "hi",
      text: { format: { type: "json_schema", name: "S", schema: { a: 1 }, strict: true } }
    });
    // Responses carries the schema flat; chat nests it under json_schema.
    assert.deepEqual(schema.response_format.json_schema, { name: "S", schema: { a: 1 }, strict: true });
  });

  test("text format and no format both mean 'not JSON mode'", () => {
    for (const text of [{ format: { type: "text" } }, undefined]) {
      assert.equal(fromResponsesRequest({ model: "m", input: "hi", text }).response_format, undefined);
    }
  });

  test("a request that sets none of them produces none of them", () => {
    // Anything invented here would change the cache key for a plain request.
    for (const r of [
      fromAnthropicRequest({ model: "m", messages: [] }),
      fromOllamaRequest({ model: "m", messages: [] }),
      fromResponsesRequest({ model: "m", input: "hi" })
    ]) {
      assert.deepEqual(
        Object.entries(sampling(r)).filter(([, v]) => v !== undefined),
        []
      );
    }
  });
});

describe("inbound: Anthropic stream blocks", () => {
  const collect = async (events) => {
    const { toAnthropicStream } = await import("../src/inbound/anthropicInbound.js");
    async function* src() { for (const chunk of events) yield { type: "chunk", chunk }; }
    const out = [];
    for await (const frame of toAnthropicStream(src(), "m")) {
      const data = frame.split("\n").find((l) => l.startsWith("data: "));
      if (data) out.push(JSON.parse(data.slice(6)));
    }
    return out;
  };
  const delta = (d, finish = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

  test("text then two tool calls make three blocks, each opened and closed once", async () => {
    const out = await collect([
      delta({ content: "Let me check." }),
      delta({ tool_calls: [{ index: 0, id: "call_a", function: { name: "read", arguments: "" } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":"a"}' } }] }),
      delta({ tool_calls: [{ index: 1, id: "call_b", function: { name: "read", arguments: '{"path":"b"}' } }] }),
      delta({}, "tool_calls")
    ]);
    const starts = out.filter((e) => e.type === "content_block_start").map((e) => e.index);
    const stops = out.filter((e) => e.type === "content_block_stop").map((e) => e.index);
    assert.deepEqual(starts, [0, 1, 2]);
    assert.deepEqual(stops, [0, 1, 2]);
    const b = out.filter((e) => e.type === "content_block_delta" && e.index === 2);
    assert.equal(b[0].delta.partial_json, '{"path":"b"}');
    for (const e of out.filter((x) => x.type === "content_block_delta")) {
      assert.ok(stops.indexOf(e.index) === -1 || out.indexOf(e) < out.findIndex((x) => x.type === "content_block_stop" && x.index === e.index), "a delta after its block closed");
    }
    assert.equal(out.find((e) => e.type === "message_delta").delta.stop_reason, "tool_use");
  });

  test("a length stop is reported as max_tokens", async () => {
    const out = await collect([delta({ content: "half" }), delta({}, "length")]);
    assert.equal(out.find((e) => e.type === "message_delta").delta.stop_reason, "max_tokens");
  });
});

describe("inbound: tool calls in the Responses and Ollama dialects", () => {
  const delta = (d, finish = null) => ({ type: "chunk", chunk: { choices: [{ index: 0, delta: d, finish_reason: finish }] } });
  async function* src(events) { for (const e of events) yield e; }
  const toolEvents = [
    delta({ content: "Checking." }),
    delta({ tool_calls: [{ index: 0, id: "call_a", function: { name: "read", arguments: '{"pa' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] }),
    delta({ tool_calls: [{ index: 1, id: "call_b", function: { name: "read", arguments: '{"path":"b"}' } }] }),
    delta({}, "tool_calls")
  ];

  test("a Responses stream carries every function call, each announced and closed", async () => {
    const { toResponsesStream } = await import("../src/inbound/responsesInbound.js");
    const out = [];
    for await (const frame of toResponsesStream(src(toolEvents), "m")) out.push(JSON.parse(frame.split("\n").find((l) => l.startsWith("data: ")).slice(6)));
    const done = out.filter((e) => e.type === "response.output_item.done").map((e) => e.item);
    assert.deepEqual(done.map((i) => i.type), ["message", "function_call", "function_call"]);
    assert.equal(done[1].arguments, '{"path":"a"}');
    assert.equal(done[2].call_id, "call_b");
    const completed = out.at(-1);
    assert.equal(completed.type, "response.completed");
    assert.equal(completed.response.output.length, 3);
    const seqs = out.map((e) => e.sequence_number);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  });

  test("a Responses stream cut off by the token limit ends incomplete", async () => {
    const { toResponsesStream } = await import("../src/inbound/responsesInbound.js");
    const frames = [];
    for await (const frame of toResponsesStream(src([delta({ content: "half" }), delta({}, "length")]), "m")) frames.push(frame);
    assert.match(frames.at(-1), /response\.incomplete/);
  });

  test("parallel function_call items become one assistant turn, and a flat tool_choice is nested", () => {
    const r = fromResponsesRequest({
      model: "m",
      input: [
        { role: "user", content: "read both" },
        { type: "function_call", call_id: "c1", name: "read", arguments: '{"p":1}' },
        { type: "function_call", call_id: "c2", name: "read", arguments: '{"p":2}' },
        { type: "function_call_output", call_id: "c1", output: "one" },
        { type: "function_call_output", call_id: "c2", output: "two" }
      ],
      tool_choice: { type: "function", name: "read" }
    });
    assert.deepEqual(r.messages.map((m) => m.role), ["user", "assistant", "tool", "tool"]);
    assert.deepEqual(r.messages[1].tool_calls.map((c) => c.id), ["c1", "c2"]);
    assert.deepEqual(r.tool_choice, { type: "function", function: { name: "read" } });
  });

  test("an Ollama stream sends tool calls whole, with object arguments", async () => {
    const { toOllamaStream } = await import("../src/inbound/ollamaInbound.js");
    const lines = [];
    for await (const l of toOllamaStream(src(toolEvents), "m")) lines.push(JSON.parse(l));
    const withCalls = lines.find((l) => l.message?.tool_calls);
    assert.deepEqual(withCalls.message.tool_calls, [
      { function: { name: "read", arguments: { path: "a" } } },
      { function: { name: "read", arguments: { path: "b" } } }
    ]);
    assert.equal(lines.at(-1).done, true);
  });

  test("Ollama tool history keeps its calls and pairs each result with one", () => {
    const r = fromOllamaRequest({
      model: "m",
      messages: [
        { role: "user", content: "weather?" },
        { role: "assistant", content: "", tool_calls: [{ function: { name: "get_weather", arguments: { city: "Ghent" } } }] },
        { role: "tool", tool_name: "get_weather", content: "18C" }
      ]
    });
    const call = r.messages[1].tool_calls[0];
    assert.equal(call.function.arguments, '{"city":"Ghent"}');
    assert.equal(r.messages[2].tool_call_id, call.id);
    const buffered = toOllamaResponse({ choices: [{ message: { content: null, tool_calls: [{ id: "x", type: "function", function: { name: "f", arguments: '{"a":1}' } }] } }] }, "m");
    assert.deepEqual(buffered.message.tool_calls, [{ function: { name: "f", arguments: { a: 1 } } }]);
  });
});
