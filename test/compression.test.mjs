import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { compressText, compressMessages, estimateSavingsPct } from "../src/compression/compress.js";

describe("compression", () => {
  test("collapses excessive blank lines", () => {
    assert.equal(compressText("a\n\n\n\n\nb"), "a\n\nb");
  });
  test("strips trailing whitespace per line", () => {
    assert.equal(compressText("a   \nb"), "a\nb");
  });
  test("keeps consecutive identical lines: count += 1 twice is not once", () => {
    assert.equal(compressText("x\nx\nx\ny"), "x\nx\nx\ny");
  });
  test("fenced code is byte-exact under every layer", () => {
    const fence = "```py\ncount += 1\ncount += 1\n```";
    assert.equal(compressText(fence), fence);
    assert.equal(compressText(fence, { rtk: true }), fence);
    assert.equal(compressText("before\n" + fence + "\nafter", { rtk: true, caveman: "aggressive" }).includes(fence), true);
    assert.equal(compressText("open ```\nx\nx\nx\nx", { rtk: true }), "open ```\nx\nx\nx\nx", "an unterminated fence protects the rest");
  });
  test("does not dedupe non-consecutive duplicates", () => {
    assert.equal(compressText("x\ny\nx"), "x\ny\nx");
  });
  test("preserves meaningful content", () => {
    const code = "function f() {\n  return 1;\n}";
    assert.equal(compressText(code), code);
  });
  test("passes through non-string input", () => {
    assert.equal(compressText(null), null);
  });

  test("keeps every message unless a window is set", () => {
    const msgs = Array.from({ length: 30 }, (_, i) => ({ role: "user", content: "m" + i }));
    assert.equal(compressMessages(msgs).length, 30);
    assert.equal(compressMessages(msgs, { historyWindow: 0 }).length, 30);
  });

  test("truncates history to the window, keeping the original task", () => {
    const msgs = Array.from({ length: 30 }, (_, i) => ({ role: "user", content: "m" + i }));
    const out = compressMessages(msgs, { historyWindow: 5 });
    assert.equal(out.length, 6);
    assert.equal(out[0].content, "m0", "the first user message is the task and always survives");
  });

  test("a cut never starts on a tool result whose call was dropped", () => {
    const msgs = [{ role: "user", content: "task" }];
    for (let i = 0; i < 6; i++) {
      msgs.push({ role: "assistant", content: null, tool_calls: [{ id: "c" + i, type: "function", function: { name: "f", arguments: "{}" } }] });
      msgs.push({ role: "tool", tool_call_id: "c" + i, content: "out" + i });
    }
    const out = compressMessages(msgs, { historyWindow: 5 });
    assert.equal(out[0].content, "task");
    assert.notEqual(out[1].role, "tool", "a tool result with no preceding call is a 400 at every provider");
    const anthropic = [{ role: "user", content: "task" }, { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "r" }] }, { role: "assistant", content: "done" }, { role: "user", content: "next" }];
    const a = compressMessages(anthropic, { historyWindow: 3 });
    assert.ok(!(Array.isArray(a[1]?.content) && a[1].content.some((p) => p.type === "tool_result")), "Anthropic tool_result blocks count as tool results");
  });

  test("always preserves system messages", () => {
    const msgs = [
      { role: "system", content: "sys" },
      ...Array.from({ length: 30 }, (_, i) => ({ role: "user", content: "m" + i }))
    ];
    const out = compressMessages(msgs, { historyWindow: 3 });
    assert.equal(out[0].role, "system");
    assert.equal(out.length, 5, "system + the task + the last 3");
  });

  test("keeps the MOST RECENT messages, not the oldest", () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({ role: "user", content: "m" + i }));
    const out = compressMessages(msgs, { historyWindow: 2 });
    assert.equal(out[out.length - 1].content, "m9");
  });

  test("computes savings percentage", () => {
    assert.equal(estimateSavingsPct(100, 50), 50);
    assert.equal(estimateSavingsPct(0, 0), 0);
  });
});
