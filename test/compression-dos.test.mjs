import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Regression tests for the compression denial-of-service.
//
// Four whitespace regexes across three files shared one shape: a greedy run
// (`[ \t]+`, `\s+`) followed by something REQUIRED that the run itself cannot
// satisfy — `\n`, `$`, or a punctuation class. On input made mostly of that
// run, the engine consumes it, fails the requirement, backtracks the entire
// run, advances a single character and does the whole thing again. Quadratic.
//
// Why it mattered more than a slow function usually does: compression runs
// inside prepare(), on every request, BEFORE routing and before any provider is
// contacted — so it needed no API key, no configured provider, and (by default)
// no gateway key. Node is single-threaded, so the one request held every other
// request behind it. 500KB of "  \t  " is well inside the 10mb body limit and
// took minutes of solid CPU.
//
// These assertions are on TIME, which is normally a bad idea. It is defensible
// here only because the failure is not a slowdown of a few percent — the
// regressed versions take minutes on inputs these bounds give seconds for, so
// the threshold sits four orders of magnitude away from the noise.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tollpike-dos-"));
process.env.TOLLPIKE_DATA_DIR = tmp;

const { compressText, compressMessagesWithStats, COMPRESSION_DEFAULTS } = await import(
  "../src/compression/compress.js"
);
const { caveman } = await import("../src/compression/caveman.js");
const { rtk, trimTrailingHorizontal } = await import("../src/compression/rtk.js");
const { redactPii } = await import("../src/security/guardrails.js");

const BUDGET_MS = 3_000;

function timed(fn) {
  const started = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

const withinBudget = (label, fn) => {
  const ms = timed(fn);
  assert.ok(
    ms < BUDGET_MS,
    `${label} took ${ms.toFixed(0)}ms (budget ${BUDGET_MS}ms) — the quadratic backtracking is back`
  );
};

// Each of these is a shape that defeated one specific regex. They are kept
// separate because fixing one file and not the others is the likely regression:
// the same `/[ \t]+\n/g` existed in BOTH compress.js and rtk.js.
const PAYLOADS = {
  "spaces and tabs, no newline": "  \t  ".repeat(100_000),
  "long run bracketed by non-whitespace": `x${" ".repeat(500_000)}y`,
  "carriage returns (\\s but not [ \\t])": `${"\r".repeat(500_000)}x`,
  "vertical tabs and form feeds": `${"\v\f".repeat(250_000)}.`,
  "whitespace before punctuation": "  \t \r\v . , ; ".repeat(60_000),
  "plain spaces at the body limit": " ".repeat(2_000_000)
};

describe("compression: quadratic backtracking on whitespace", () => {
  for (const [label, payload] of Object.entries(PAYLOADS)) {
    test(`base pass survives ${label}`, () => {
      withinBudget("compressText", () => compressText(payload));
    });

    test(`rtk survives ${label}`, () => {
      withinBudget("rtk", () => rtk(payload));
    });

    test(`caveman (aggressive) survives ${label}`, () => {
      withinBudget("caveman", () => caveman(payload, { level: "aggressive" }));
    });
  }

  test("the full pipeline survives a request-shaped payload", () => {
    const config = {
      ...COMPRESSION_DEFAULTS,
      enabled: true,
      caveman: { ...COMPRESSION_DEFAULTS.caveman, enabled: true, scope: "all", level: "aggressive" }
    };
    withinBudget("compressMessagesWithStats", () =>
      compressMessagesWithStats([{ role: "user", content: "  \t  ".repeat(100_000) }], config)
    );
  });

  // Growth check, which catches the regression even if a future machine is fast
  // enough to brute-force the fixed-size payloads above inside the budget.
  test("cost grows linearly, not quadratically, with input size", () => {
    const build = (n) => `x${" ".repeat(n)}y`;
    const small = Math.max(timed(() => compressText(build(50_000))), 0.5);
    const large = timed(() => compressText(build(400_000))); // 8x the input

    // Linear predicts ~8x. Quadratic predicts ~64x. Allow generous headroom for
    // GC and allocation noise and still catch the real thing.
    assert.ok(
      large / small < 25,
      `8x the input cost ${(large / small).toFixed(1)}x the time (${small.toFixed(1)}ms -> ${large.toFixed(1)}ms) — that curve is quadratic`
    );
  });
});

// The PII scanner had the same defect as the compression passes, and it is
// worth its own block because the exposure runs the opposite way round: this
// pattern only executes when redactPii is ENABLED, so turning on a data
// -protection feature was what made the gateway killable.
describe("guardrails: PII patterns cannot be made quadratic", () => {
  const SHAPES = {
    "local-part run with no @": "a.b_c%d+e-".repeat(50_000),
    "domain run with no TLD dot": "a@" + "b-c".repeat(150_000) + "!",
    "long digit run": "4".repeat(500_000) + "x",
    "IBAN-shaped groups": "BE71" + "ABCD".repeat(100_000) + "!",
    "BEGIN PRIVATE KEY with no END": "-----BEGIN " + "A ".repeat(100_000) + "PRIVATE KEY-----",
    "eyJ prefix, no dots": "eyJ" + "A".repeat(500_000)
  };

  for (const [label, payload] of Object.entries(SHAPES)) {
    test(`redactPii survives ${label}`, () => {
      withinBudget("redactPii", () => redactPii(payload));
    });
  }

  test("cost grows linearly with input size", () => {
    const build = (n) => "a.b_c%d+e-".repeat(n / 10) + "x";
    const small = Math.max(timed(() => redactPii(build(16_000))), 0.5);
    const large = timed(() => redactPii(build(128_000))); // 8x
    assert.ok(
      large / small < 25,
      `8x the input cost ${(large / small).toFixed(1)}x the time — that curve is quadratic`
    );
  });

  // Bounding the quantifiers must not narrow what the scanner catches. The
  // bounds are RFC 5321's real limits, so these all still have to match.
  test("real addresses are still redacted", () => {
    for (const address of [
      "plain@example.com",
      "first.last@example.co.uk",
      "a+tag@sub.domain.org",
      "user_name@example-host.com",
      "x%y@e.io",
      "UPPER@EXAMPLE.COM",
      `${"a".repeat(64)}@example.com` // the RFC maximum local part
    ]) {
      const result = redactPii(`contact ${address} today`);
      assert.ok(result.found.includes("email"), `${address} must be detected`);
      assert.match(result.text, /\[REDACTED_EMAIL\]/);
    }
  });

  test("non-addresses are still ignored", () => {
    for (const text of ["no at sign here", "a@b", "@example.com", "user@", "price is 5@10"]) {
      assert.ok(!redactPii(text).found.includes("email"), `${JSON.stringify(text)} is not an email`);
    }
  });
});

describe("compression: the linear helper behaves like the regex it replaced", () => {
  test("strips only trailing spaces and tabs", () => {
    assert.equal(trimTrailingHorizontal("a  \t "), "a");
    assert.equal(trimTrailingHorizontal("  a"), "  a", "leading whitespace is not this function's job");
    assert.equal(trimTrailingHorizontal("a"), "a");
    assert.equal(trimTrailingHorizontal(""), "");
    assert.equal(trimTrailingHorizontal("   "), "");
  });

  test("returns the identical string when there is nothing to strip", () => {
    const input = "unchanged";
    assert.equal(trimTrailingHorizontal(input), input);
  });

  test("does not eat newlines or carriage returns", () => {
    assert.equal(trimTrailingHorizontal("a\r"), "a\r", "\\r is not [ \\t] — the old regex left it too");
  });
});

describe("compression: output is unchanged by the rewrite", () => {
  const cases = [
    ["trailing whitespace before newline", "a   \nb\t\t\nc", "a\nb\nc"],
    ["three or more newlines collapse to two", "a\n\n\n\n\nb", "a\n\nb"],
    ["exactly two newlines are preserved", "a\n\nb", "a\n\nb"],
    ["consecutive duplicate lines collapse", "x\nx\nx\ny", "x\ny"],
    ["a whitespace-only line becomes a kept blank", "a\n \na", "a\n\na"],
    ["text needing no change is returned as-is", "hello world", "hello world"],
    ["a leading blank line is preserved", "\na", "\na"],
    ["a trailing newline is preserved", "a\n", "a\n"]
  ];

  for (const [label, input, expected] of cases) {
    test(label, () => assert.equal(compressText(input), expected));
  }
});
