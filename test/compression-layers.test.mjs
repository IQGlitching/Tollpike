import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rtk, _internals as rtkInternals } from "../src/compression/rtk.js";
import { caveman, _internals as cavemanInternals } from "../src/compression/caveman.js";
import { compressText, compressMessagesWithStats } from "../src/compression/compress.js";

describe("RTK", () => {
  test("tabularizes a uniform JSON array", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      id: i,
      name: `item-${i}`,
      status: "active"
    }));
    const out = rtk(JSON.stringify(rows));
    assert.match(out, /^⟨tsv rows=8 cols=id,name,status⟩/);
    // The point of the pass: keys printed once, not eight times.
    assert.equal((out.match(/status/g) || []).length, 2); // header marker + column row
    assert.ok(out.length < JSON.stringify(rows).length * 0.75);
  });

  test("the win grows with row count", () => {
    // 8 rows of 3 short keys is a modest saving; the 80-95% figures come from
    // wide rows and long arrays, and the ratio has to improve with both or
    // the pass is not doing what it claims.
    const ratio = (n) => {
      const rows = Array.from({ length: n }, (_, i) => ({
        identifier: i,
        display_name: `item-${i}`,
        current_status: "active",
        last_updated_at: "2026-08-08T00:00:00Z"
      }));
      const json = JSON.stringify(rows);
      return rtk(json).length / json.length;
    };
    assert.ok(ratio(100) < ratio(5));
    assert.ok(ratio(100) < 0.45, `expected >55% saving on 100 wide rows, got ${ratio(100)}`);
  });

  test("reaches a table one level inside an envelope", () => {
    const payload = { total: 3, items: [{ a: 1, b: 2 }, { a: 3, b: 4 }, { a: 5, b: 6 }] };
    const out = rtk(JSON.stringify(payload));
    assert.match(out, /items:/);
    assert.match(out, /⟨tsv rows=3 cols=a,b⟩/);
    assert.match(out, /"total":3/); // the rest of the envelope survives
  });

  test("refuses to tabularize a ragged array", () => {
    // An empty cell cannot distinguish "key absent" from "empty string", so a
    // ragged array must be left alone rather than quietly reshaped.
    const ragged = JSON.stringify([{ a: 1, b: 2 }, { a: 3 }, { a: 5, b: 6 }]);
    assert.equal(rtkInternals.tabularizeJson(ragged), ragged);
  });

  test("does not touch text that is not whole-document JSON", () => {
    const text = "here is some output: {broken";
    assert.equal(rtkInternals.tabularizeJson(text), text);
  });

  test("collapses a repeated run and keeps the count", () => {
    const out = rtk("progress\nprogress\nprogress\nprogress\ndone");
    assert.match(out, /progress ⟨×4⟩/);
    assert.match(out, /done/);
  });

  test("leaves a 2-line repeat below the run threshold intact-ish", () => {
    const out = rtk("x\nx\ny", { whitespace: false });
    assert.ok(!out.includes("×"));
  });

  test("elides a data URI but reports its size", () => {
    const blob = "A".repeat(200);
    const out = rtk(`img: data:image/png;base64,${blob}`);
    assert.match(out, /⟨data-uri \d+c elided⟩/);
    assert.ok(!out.includes(blob));
  });

  test("keeps a plausible id rather than eliding it", () => {
    // 100 chars is a blob; a 40-char hash is an identifier that matters.
    const hash = "a".repeat(40);
    assert.match(rtk(`sha=${hash}`), new RegExp(hash));
  });

  test("dictionary pass is off by default", () => {
    const repeated = Array.from({ length: 5 }, () => "a fairly long repeated line of text").join("\n");
    assert.ok(!rtk(repeated).includes("⟨legend"));
    assert.ok(rtk(repeated, { dictionary: true, runs: false }).includes("⟨legend"));
  });

  test("passes through non-string input", () => {
    assert.equal(rtk(null), null);
  });
});

describe("Caveman", () => {
  test("light level rewrites verbose constructions", () => {
    assert.equal(caveman("You need in order to run it", { level: "light" }), "You need to run it");
  });

  test("aggressive level drops articles and copulas", () => {
    const out = caveman("The file is in the directory", { level: "aggressive" });
    assert.equal(out, "File directory");
  });

  test("off level is a no-op", () => {
    const text = "The file is in the directory";
    assert.equal(caveman(text, { level: "off" }), text);
  });

  test("NEVER drops a negation at any level", () => {
    // This is the safety invariant the whole lossy layer rests on: removing
    // "not" does not compress an instruction, it inverts it.
    for (const level of ["light", "aggressive"]) {
      for (const word of ["not", "never", "without", "unless", "except", "no"]) {
        const out = caveman(`do ${word} delete the table`, { level });
        assert.match(out, new RegExp(`\\b${word}\\b`), `${level} dropped "${word}"`);
      }
    }
  });

  test("every NEVER_DROP word is absent from DROPPABLE", () => {
    for (const word of cavemanInternals.NEVER_DROP) {
      assert.ok(
        !cavemanInternals.DROPPABLE.has(word),
        `"${word}" is in both DROPPABLE and NEVER_DROP`
      );
    }
  });

  test("leaves fenced code untouched", () => {
    const code = "```\nconst a = the thing;\n```";
    assert.equal(caveman(`Here is the code:\n${code}`, { level: "aggressive" }).includes("const a = the thing;"), true);
  });

  test("leaves inline code, paths, urls and versions untouched", () => {
    const out = caveman(
      "Run `npm install` in the src/routing dir at https://x.dev/a with v1.2.3",
      { level: "aggressive" }
    );
    assert.match(out, /`npm install`/);
    assert.match(out, /src\/routing/);
    assert.match(out, /https:\/\/x\.dev\/a/);
    assert.match(out, /v1\.2\.3/);
  });

  test("does not mangle a line that is code rather than prose", () => {
    const line = "const x = { a: 1 };";
    assert.equal(caveman(line, { level: "aggressive" }), line);
    assert.ok(cavemanInternals.looksLikeCode(line));
  });

  test("preserves sentence boundaries when dropping a trailing word", () => {
    const out = caveman("Read the file. Then run it.", { level: "aggressive" });
    assert.match(out, /\./);
    assert.equal(out.split(".").filter((s) => s.trim()).length, 2);
  });
});

describe("compression pipeline", () => {
  const messages = [
    { role: "system", content: "You are a helpful assistant.   " },
    { role: "user", content: "In order to fix the bug, what is the first thing I should do?" },
    { role: "assistant", content: "It is important to note that the file is in the src directory." },
    { role: "tool", content: JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ id: i, ok: true, note: "x" }))) },
    { role: "user", content: "In order to proceed, should I not delete the table?" }
  ];

  test("reports per-layer attribution", () => {
    const { stats } = compressMessagesWithStats(messages, {
      historyWindow: 12,
      rtk: { enabled: true },
      caveman: { enabled: true, level: "aggressive", scope: "tools+history" }
    });
    assert.ok(stats.savedPct > 0);
    assert.equal(
      stats.byPass.truncation.savedChars + stats.byPass.rtk.savedChars + stats.byPass.caveman.savedChars,
      stats.beforeChars - stats.afterChars
    );
  });

  test("never caveman-compresses the system prompt", () => {
    const { messages: out } = compressMessagesWithStats(messages, {
      caveman: { enabled: true, level: "aggressive", scope: "all" }
    });
    assert.match(out[0].content, /You are a helpful assistant\./);
  });

  test("leaves the newest user turn alone unless scope is 'all'", () => {
    const { messages: out } = compressMessagesWithStats(messages, {
      caveman: { enabled: true, level: "aggressive", scope: "tools+history" }
    });
    const newest = out[out.length - 1];
    assert.match(newest.content, /should I not delete the table/);
  });

  test("scope 'all' does compress the newest turn", () => {
    const { messages: out } = compressMessagesWithStats(messages, {
      caveman: { enabled: true, level: "aggressive", scope: "all" }
    });
    const newest = out[out.length - 1];
    assert.ok(newest.content.length < messages[messages.length - 1].content.length);
    assert.match(newest.content, /\bnot\b/); // still not allowed to invert it
  });

  test("tabularizes tool output", () => {
    const { messages: out } = compressMessagesWithStats(messages, { rtk: { enabled: true } });
    const tool = out.find((m) => m.role === "tool");
    assert.match(tool.content, /⟨tsv rows=6/);
  });

  test("compresses text parts of multimodal content and leaves other parts alone", () => {
    const multimodal = [
      {
        role: "user",
        content: [
          { type: "text", text: "It is important to note that   this is the thing" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
        ]
      }
    ];
    const { messages: out } = compressMessagesWithStats(multimodal, {
      caveman: { enabled: true, level: "aggressive", scope: "all" }
    });
    assert.equal(out[0].content[1].type, "image_url");
    assert.equal(out[0].content[1].image_url.url, "data:image/png;base64,AAAA");
    assert.ok(out[0].content[0].text.length < multimodal[0].content[0].text.length);
  });

  test("compressText with no options is still the original base pass", () => {
    assert.equal(compressText("x\nx\nx\ny"), "x\ny");
    assert.equal(compressText("a\n\n\n\n\nb"), "a\n\nb");
  });
});
