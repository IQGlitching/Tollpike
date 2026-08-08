import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { callOpenAICompatible, streamOpenAICompatible, ProviderError } from "../src/providers/openaiCompatible.js";
import { readWithStallTimeout } from "../src/providers/http.js";
import { callAnthropic, streamAnthropic } from "../src/providers/anthropic.js";
import { callGemini, streamGemini } from "../src/providers/gemini.js";

// Real HTTP servers speaking each provider's real wire format. These catch
// the class of bug unit tests can't: SSE framing, header handling, status
// mapping, and partial-chunk buffering.
function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, () => resolve({ server, port: server.address().port }));
  });
}
const close = (s) => new Promise((r) => s.close(r));

describe("openai-compatible adapter", () => {
  let ctx;
  before(async () => {
    ctx = await startServer((req, res) => {
      if (req.url.includes("fail429")) {
        res.writeHead(429); res.end(JSON.stringify({ error: "rate limited" })); return;
      }
      let body = ""; req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        if (parsed.stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
          res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            id: "c1",
            choices: [{ message: { role: "assistant", content: "Hello" } }],
            usage: { prompt_tokens: 3, completion_tokens: 2 }
          }));
        }
      });
    });
  });
  after(() => close(ctx.server));

  test("normalizes a buffered response", async () => {
    const p = { id: "t", baseURL: `http://localhost:${ctx.port}/v1` };
    const r = await callOpenAICompatible(p, { resolvedModel: "m", messages: [] }, "k");
    assert.equal(r.choices[0].message.content, "Hello");
    assert.equal(r.usage.total_tokens, 5);
    assert.equal(r.provider, "t");
  });

  test("marks 429 as retryable", async () => {
    const p = { id: "t", baseURL: `http://localhost:${ctx.port}/fail429` };
    await assert.rejects(
      () => callOpenAICompatible(p, { resolvedModel: "m", messages: [] }, "k"),
      (err) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.status, 429);
        assert.equal(err.retryable, true);
        return true;
      }
    );
  });

  // The adapter now returns { body, controller } rather than a bare stream:
  // the controller is what lets the stall watchdog abort a stream that goes
  // silent, instead of the request hanging forever.
  test("streams as a passthrough byte stream", async () => {
    const p = { id: "t", baseURL: `http://localhost:${ctx.port}/v1` };
    const { body, controller } = await streamOpenAICompatible(
      p,
      { resolvedModel: "m", messages: [] },
      "k"
    );
    assert.ok(controller instanceof AbortController, "must expose an abort handle for the watchdog");

    const decoder = new TextDecoder();
    let all = "";
    for await (const chunk of readWithStallTimeout(body, p.id, controller)) {
      all += decoder.decode(chunk, { stream: true });
    }
    assert.match(all, /\[DONE\]/);
    assert.match(all, /Hel/);
  });
});

describe("anthropic adapter", () => {
  let ctx, lastRequest;
  before(async () => {
    ctx = await startServer((req, res) => {
      let body = ""; req.on("data", (c) => (body += c));
      req.on("end", () => {
        lastRequest = JSON.parse(body);
        if (lastRequest.stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          const evts = [
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi " } },
            { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "f" } },
            { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"a"' } },
            { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ":1}" } },
            { type: "message_delta", delta: { stop_reason: "tool_use" } }
          ];
          for (const e of evts) res.write(`data: ${JSON.stringify(e)}\n\n`);
          res.end();
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            id: "msg1",
            content: [{ type: "text", text: "Hi" }, { type: "tool_use", id: "t1", name: "f", input: { a: 1 } }],
            stop_reason: "tool_use",
            usage: { input_tokens: 4, output_tokens: 3 }
          }));
        }
      });
    });
  });
  after(() => close(ctx.server));

  test("sends tools as input_schema", async () => {
    const p = { id: "anthropic", baseURL: `http://localhost:${ctx.port}` };
    await callAnthropic(p, {
      resolvedModel: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }]
    }, "k");
    assert.ok(lastRequest.tools[0].input_schema);
    assert.equal(lastRequest.tools[0].name, "f");
  });

  test("converts tool_use response to OpenAI tool_calls", async () => {
    const p = { id: "anthropic", baseURL: `http://localhost:${ctx.port}` };
    const r = await callAnthropic(p, { resolvedModel: "m", messages: [{ role: "user", content: "hi" }] }, "k");
    assert.equal(r.choices[0].finish_reason, "tool_calls");
    assert.equal(r.choices[0].message.tool_calls[0].function.name, "f");
    assert.equal(r.usage.prompt_tokens, 4);
  });

  test("streams tool-call argument fragments that concatenate to valid JSON", async () => {
    const p = { id: "anthropic", baseURL: `http://localhost:${ctx.port}` };
    const chunks = [];
    for await (const c of streamAnthropic(p, { resolvedModel: "m", messages: [{ role: "user", content: "hi" }], stream: true }, "k")) {
      chunks.push(c);
    }
    const args = chunks
      .map((c) => c.choices[0].delta.tool_calls?.[0]?.function?.arguments)
      .filter((a) => a !== undefined)
      .join("");
    assert.equal(args, '{"a":1}');
    assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, "tool_calls");
  });
});

describe("gemini adapter", () => {
  let ctx, lastRequest;
  before(async () => {
    ctx = await startServer((req, res) => {
      let body = ""; req.on("data", (c) => (body += c));
      req.on("end", () => {
        lastRequest = JSON.parse(body);
        if (req.url.includes("streamGenerateContent")) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hi" }] } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "f", args: { a: 1 } } }] } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] })}\n\n`);
          res.end();
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            candidates: [{ content: { parts: [{ text: "Hi" }, { functionCall: { name: "f", args: { a: 1 } } }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 }
          }));
        }
      });
    });
  });
  after(() => close(ctx.server));

  test("sends functionDeclarations", async () => {
    const p = { id: "gemini", baseURL: `http://localhost:${ctx.port}` };
    await callGemini(p, {
      resolvedModel: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "f", parameters: {} } }]
    }, "k");
    assert.equal(lastRequest.tools[0].functionDeclarations[0].name, "f");
  });

  test("converts functionCall to OpenAI tool_calls", async () => {
    const p = { id: "gemini", baseURL: `http://localhost:${ctx.port}` };
    const r = await callGemini(p, { resolvedModel: "m", messages: [{ role: "user", content: "hi" }] }, "k");
    assert.equal(r.choices[0].finish_reason, "tool_calls");
    assert.equal(r.choices[0].message.tool_calls[0].function.name, "f");
  });

  test("streams text then a complete tool call", async () => {
    const p = { id: "gemini", baseURL: `http://localhost:${ctx.port}` };
    const chunks = [];
    for await (const c of streamGemini(p, { resolvedModel: "m", messages: [{ role: "user", content: "hi" }] }, "k")) {
      chunks.push(c);
    }
    assert.equal(chunks[0].choices[0].delta.content, "Hi");
    assert.equal(chunks[1].choices[0].delta.tool_calls[0].function.arguments, '{"a":1}');
    assert.equal(chunks[2].choices[0].finish_reason, "tool_calls");
  });
});
