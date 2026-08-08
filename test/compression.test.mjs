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
  test("dedupes consecutive identical lines", () => {
    assert.equal(compressText("x\nx\nx\ny"), "x\ny");
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

  test("truncates history to the window", () => {
    const msgs = Array.from({ length: 30 }, (_, i) => ({ role: "user", content: "m" + i }));
    assert.equal(compressMessages(msgs, { historyWindow: 5 }).length, 5);
  });

  test("always preserves system messages", () => {
    const msgs = [
      { role: "system", content: "sys" },
      ...Array.from({ length: 30 }, (_, i) => ({ role: "user", content: "m" + i }))
    ];
    const out = compressMessages(msgs, { historyWindow: 3 });
    assert.equal(out[0].role, "system");
    assert.equal(out.length, 4);
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
