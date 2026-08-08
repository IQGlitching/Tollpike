import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Regression tests for the unauthenticated remote crash.
//
// `POST /v1/chat/completions {"model":"a","messages":[null]}` terminated the
// gateway process. Three separate things had to be true for a three-character
// body to cause a total outage, and all three were:
//
//   1. Validation checked the CONTAINER (`Array.isArray(messages)`) and never
//      the elements, so `[null]` was accepted as a valid message list.
//   2. The compression pass dereferenced `m.role` / `m.content` unguarded and
//      threw a TypeError.
//   3. Express 4 does not catch a rejected promise from an async handler, so
//      the throw escaped as an unhandledRejection — and Node's default policy
//      for that is to kill the process.
//
// Any one of those being false would have made this a 400 or a 500 instead of
// an outage. The fix addresses all three, and this file pins all three, because
// fixing only the reachable one leaves the mechanism intact for the next bug.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tollpike-shape-"));
process.env.TOLLPIKE_DATA_DIR = tmp;

const { validateMessages } = await import("../src/inbound/validate.js");
const { compressMessagesWithStats, COMPRESSION_DEFAULTS } = await import(
  "../src/compression/compress.js"
);

const src = (rel) => fs.readFileSync(path.join(import.meta.dirname, "..", "src", rel), "utf-8");

describe("request shape: message elements are validated, not just the array", () => {
  test("the exact body that crashed the gateway is rejected", () => {
    const result = validateMessages([null]);
    assert.equal(result.ok, false);
    assert.match(result.error, /messages\[0\] must be an object/);
  });

  test("every non-object element shape is rejected", () => {
    for (const bad of [null, undefined, 42, "text", true, []]) {
      const result = validateMessages([bad]);
      assert.equal(result.ok, false, `${JSON.stringify(bad)} is not a message`);
    }
  });

  test("an object without a usable role is rejected", () => {
    assert.equal(validateMessages([{ content: "x" }]).ok, false);
    assert.equal(validateMessages([{ role: "", content: "x" }]).ok, false);
    assert.equal(validateMessages([{ role: 42, content: "x" }]).ok, false);
  });

  test("the offending index is named, so the caller can find it", () => {
    assert.match(validateMessages([{ role: "user" }, { role: "user" }, null]).error, /messages\[2\]/);
  });

  test("legitimate messages pass, including unusual but valid content", () => {
    assert.equal(validateMessages([]).ok, true);
    assert.equal(validateMessages([{ role: "user", content: "hi" }]).ok, true);
    assert.equal(validateMessages([{ role: "tool", content: null }]).ok, true, "null content is legal");
    assert.equal(validateMessages([{ role: "user" }]).ok, true, "absent content is legal");
    assert.equal(
      validateMessages([{ role: "user", content: [{ type: "text", text: "x" }] }]).ok,
      true,
      "multimodal parts are legal"
    );
    assert.equal(
      validateMessages([{ role: "some-future-role", content: "x" }]).ok,
      true,
      "roles are not restricted — dialects disagree and rejecting one upstream accepts is a broken gateway"
    );
  });

  test("an absurd message count is refused rather than processed", () => {
    const huge = Array.from({ length: 10_001 }, () => ({ role: "user", content: "x" }));
    assert.equal(validateMessages(huge).ok, false);
  });
});

describe("request shape: compression tolerates malformed entries", () => {
  const config = { ...COMPRESSION_DEFAULTS, enabled: true };

  // Layer 2. Even with validation in front, this pass must not be what decides
  // whether the process survives a strange input.
  test("does not throw on null entries", () => {
    assert.doesNotThrow(() => compressMessagesWithStats([null], config));
    assert.doesNotThrow(() => compressMessagesWithStats([null, { role: "user", content: "x" }], config));
    assert.doesNotThrow(() => compressMessagesWithStats([42, "x", [], undefined], config));
  });

  test("carries malformed entries through instead of silently dropping them", () => {
    // Dropping would change the prompt, which is the one thing a compression
    // pass must never do invisibly.
    const result = compressMessagesWithStats([null, { role: "user", content: "hello" }], config);
    assert.equal(result.messages.length, 2, "the entry count is preserved");
    assert.equal(result.messages[0], null);
  });

  test("still compresses the valid entries around a malformed one", () => {
    const result = compressMessagesWithStats(
      [null, { role: "user", content: "a   \nb   \nb   " }],
      config
    );
    assert.ok(!result.messages[1].content.includes("   \n"), "trailing whitespace still collapsed");
  });
});

describe("request shape: async handler rejections cannot kill the process", () => {
  const server = src("server.js");

  test("route handlers are wrapped at registration", () => {
    assert.ok(
      /rejectionSafe/.test(server),
      "Express 4 lets an async handler's rejection escape; it must be caught"
    );
    assert.ok(
      /Promise\.resolve\(handler\(req, res, next\)\)\.catch\(next\)/.test(server),
      "a rejection must be routed to the error handler, not left unhandled"
    );
  });

  test("the wrapper is installed before any route is registered", () => {
    const wrapAt = server.indexOf('for (const method of ["get", "post", "put", "delete", "patch", "all"])');
    const firstRoute = server.indexOf('app.get("/health"');
    assert.ok(wrapAt !== -1 && firstRoute !== -1);
    assert.ok(wrapAt < firstRoute, "a route registered before the wrapper would be unprotected");
  });

  test("Express's settings getter (app.get with no handler) still works", () => {
    // app.get("etag") must not be treated as a route registration.
    assert.ok(
      /if \(handlers\.length === 0\) return register\(path\)/.test(server),
      "app.get('setting') is a getter, not a route"
    );
  });

  test("synchronous throws take the same path", () => {
    assert.ok(/catch \(err\) \{\s*return next\(err\)/.test(server));
  });
});

describe("request shape: model is type-checked on every dialect", () => {
  const server = src("server.js");

  test("a numeric model is a 400, not a 502 blamed on the upstream", () => {
    // A number is truthy, so `!body.model` passed it through to routing, where
    // it matched nothing and surfaced as "all providers failed".
    const checks = server.match(/typeof body\.model !== "string"/g) || [];
    assert.ok(
      checks.length >= 4,
      `all four inbound dialects must type-check model, found ${checks.length}`
    );
  });
});
