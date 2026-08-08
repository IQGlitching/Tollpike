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
});
