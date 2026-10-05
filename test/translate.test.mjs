import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as anth from "../src/providers/anthropicTranslate.js";
import * as gem from "../src/providers/geminiTranslate.js";

const TOOL_HISTORY = [
  { role: "user", content: "weather?" },
  {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Ghent"}' } }
    ]
  },
  { role: "tool", tool_call_id: "call_1", content: '{"temp":18}' }
];

describe("anthropic translation", () => {
  test("converts tool_calls to tool_use blocks", () => {
    const out = anth.toAnthropicMessages(TOOL_HISTORY);
    const assistant = out.find((m) => m.role === "assistant");
    assert.equal(assistant.content[0].type, "tool_use");
    assert.deepEqual(assistant.content[0].input, { city: "Ghent" });
  });

  test("converts tool role to tool_result in a user message", () => {
    const out = anth.toAnthropicMessages(TOOL_HISTORY);
    const last = out[out.length - 1];
    assert.equal(last.role, "user");
    assert.equal(last.content[0].type, "tool_result");
    assert.equal(last.content[0].tool_use_id, "call_1");
  });

  test("enforces strict role alternation by merging", () => {
    const out = anth.toAnthropicMessages([
      { role: "user", content: "two things" },
      { role: "assistant", content: null, tool_calls: [
        { id: "a", type: "function", function: { name: "fa", arguments: "{}" } },
        { id: "b", type: "function", function: { name: "fb", arguments: "{}" } }
      ] },
      { role: "tool", tool_call_id: "a", content: "1" },
      { role: "tool", tool_call_id: "b", content: "2" }
    ]);
    out.forEach((m, i) => {
      if (i > 0) assert.notEqual(m.role, out[i - 1].role, "roles must alternate");
    });
  });

  test("drops system messages (handled as a top-level field)", () => {
    const out = anth.toAnthropicMessages([{ role: "system", content: "sys" }, { role: "user", content: "hi" }]);
    assert.ok(!out.some((m) => m.role === "system"));
  });

  test("degrades gracefully on malformed tool arguments", () => {
    const out = anth.toAnthropicMessages([
      { role: "assistant", content: null, tool_calls: [{ id: "x", type: "function", function: { name: "f", arguments: "{bad json" } }] }
    ]);
    assert.deepEqual(out[0].content[0].input, {});
  });

  test("converts tools to input_schema", () => {
    const out = anth.toAnthropicTools([
      { type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } }
    ]);
    assert.equal(out[0].input_schema.type, "object");
    assert.equal(out[0].name, "f");
  });

  test("maps every tool_choice variant", () => {
    assert.equal(anth.toAnthropicToolChoice("auto"), undefined);
    assert.deepEqual(anth.toAnthropicToolChoice("required"), { type: "any" });
    assert.deepEqual(anth.toAnthropicToolChoice({ type: "function", function: { name: "f" } }), { type: "tool", name: "f" });
  });

  test("converts tool_use response back to OpenAI shape", () => {
    const r = anth.fromAnthropicContent(
      [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "f", input: { a: 1 } }],
      "tool_use"
    );
    assert.equal(r.finishReason, "tool_calls");
    assert.equal(r.toolCalls[0].function.arguments, '{"a":1}');
  });
});

describe("gemini translation", () => {
  test("wraps tools in functionDeclarations", () => {
    const out = gem.toGeminiTools([{ type: "function", function: { name: "f", parameters: {} } }]);
    assert.equal(out[0].functionDeclarations[0].name, "f");
  });

  test("maps tool_choice to functionCallingConfig modes", () => {
    assert.deepEqual(gem.toGeminiToolConfig("required"), { functionCallingConfig: { mode: "ANY" } });
    assert.deepEqual(gem.toGeminiToolConfig("none"), { functionCallingConfig: { mode: "NONE" } });
  });

  test("resolves tool_call_id back to the function name (Gemini has no call IDs)", () => {
    const out = gem.toGeminiContents(TOOL_HISTORY);
    const last = out[out.length - 1];
    assert.equal(last.parts[0].functionResponse.name, "get_weather");
  });

  test("wraps non-JSON tool output instead of throwing", () => {
    const out = gem.toGeminiContents([
      { role: "assistant", content: null, tool_calls: [{ id: "z", type: "function", function: { name: "fz", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "z", content: "plain text" }
    ]);
    assert.deepEqual(out[out.length - 1].parts[0].functionResponse.response, { result: "plain text" });
  });

  test("enforces role alternation", () => {
    const out = gem.toGeminiContents([
      { role: "user", content: "x" },
      { role: "assistant", content: null, tool_calls: [
        { id: "a", type: "function", function: { name: "fa", arguments: "{}" } },
        { id: "b", type: "function", function: { name: "fb", arguments: "{}" } }
      ] },
      { role: "tool", tool_call_id: "a", content: "{}" },
      { role: "tool", tool_call_id: "b", content: "{}" }
    ]);
    out.forEach((m, i) => {
      if (i > 0) assert.notEqual(m.role, out[i - 1].role);
    });
  });

  test("uses 'model' role for assistant turns", () => {
    const out = gem.toGeminiContents([{ role: "assistant", content: "hi" }]);
    assert.equal(out[0].role, "model");
  });

  test("converts functionCall parts back to OpenAI tool_calls", () => {
    const r = gem.fromGeminiParts([{ text: "ok" }, { functionCall: { name: "f", args: { a: 1 } } }], "STOP");
    assert.equal(r.finishReason, "tool_calls");
    assert.equal(r.toolCalls[0].function.name, "f");
  });
});

// A reply cut off by the token limit has to say so. Mapped to "stop", it
// looked complete and no client could ask for the rest.
describe("finish reasons survive translation", () => {
  test("Anthropic stop reasons", () => {
    assert.equal(anth.finishFromAnthropic("max_tokens"), "length");
    assert.equal(anth.finishFromAnthropic("tool_use"), "tool_calls");
    assert.equal(anth.finishFromAnthropic("refusal"), "content_filter");
    assert.equal(anth.finishFromAnthropic("end_turn"), "stop");
    assert.equal(anth.fromAnthropicContent([{ type: "text", text: "half a sen" }], "max_tokens").finishReason, "length");
  });

  test("Gemini finish reasons", () => {
    assert.equal(gem.finishFromGemini("MAX_TOKENS", false), "length");
    assert.equal(gem.finishFromGemini("SAFETY", false), "content_filter");
    assert.equal(gem.finishFromGemini("STOP", true), "tool_calls");
    assert.equal(gem.fromGeminiParts([{ text: "half" }], "MAX_TOKENS").finishReason, "length");
  });
});

describe("system instructions and tool choice", () => {
  test("every system and developer message reaches the provider, in order", async () => {
    const { systemTextOf } = await import("../src/providers/normalize.js");
    const msgs = [
      { role: "system", content: "Be brief." },
      { role: "developer", content: [{ type: "text", text: "Answer in Dutch." }] },
      { role: "user", content: "hi" },
      { role: "system", content: "Never guess." }
    ];
    assert.equal(systemTextOf(msgs), "Be brief.\n\nAnswer in Dutch.\n\nNever guess.");
    assert.equal(systemTextOf([{ role: "user", content: "hi" }]), undefined);
    assert.ok(!anth.toAnthropicMessages(msgs).some((m) => m.role === "developer" || m.role === "system"));
    assert.ok(!gem.toGeminiContents(msgs).some((m) => m.role === "developer" || m.role === "system"));
  });

  test("tool_choice none stays none", () => {
    assert.deepEqual(anth.toAnthropicToolChoice("none"), { type: "none" });
    assert.deepEqual(gem.toGeminiToolConfig("none"), { functionCallingConfig: { mode: "NONE" } });
  });
});

describe("usage as billed", () => {
  test("Anthropic cache writes and reads count as prompt tokens", () => {
    assert.equal(anth.anthropicPromptTokens({ input_tokens: 10, cache_creation_input_tokens: 2000, cache_read_input_tokens: 30000 }), 32010);
    assert.equal(anth.anthropicPromptTokens({ input_tokens: 7 }), 7);
    assert.equal(anth.anthropicPromptTokens({ output_tokens: 3 }), null, "no input figure is not zero");
  });

  test("Gemini thinking tokens count as output", () => {
    assert.equal(gem.geminiCompletionTokens({ candidatesTokenCount: 40, thoughtsTokenCount: 900 }), 940);
    assert.equal(gem.geminiCompletionTokens({ promptTokenCount: 5 }), null);
  });
});
