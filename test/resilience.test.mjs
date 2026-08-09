import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as r from "../src/routing/resilience.js";

beforeEach(() => r.reset());

describe("resilience: failure classification picks the smallest scope", () => {
  test("401 cools the connection only", () => {
    assert.equal(r.classifyAndRecord("p", "p#0", "m", { status: 401 }), "connection");
    assert.equal(r.isProviderAvailable("p"), true, "provider must stay up");
    assert.equal(r.isConnectionAvailable("p", "p#0"), false);
    assert.equal(r.isConnectionAvailable("p", "p#1"), true, "other keys keep serving");
    assert.equal(r.isModelAvailable("p", "m"), true);
  });

  test("403 also cools the connection", () => {
    assert.equal(r.classifyAndRecord("p", "p#0", "m", { status: 403 }), "connection");
  });

  test("429 locks the model only", () => {
    assert.equal(r.classifyAndRecord("p", "p#0", "big-model", { status: 429 }), "model");
    assert.equal(r.isProviderAvailable("p"), true);
    assert.equal(r.isConnectionAvailable("p", "p#0"), true, "key keeps serving");
    assert.equal(r.isModelAvailable("p", "big-model"), false);
    assert.equal(r.isModelAvailable("p", "other-model"), true, "other models keep serving");
  });

  test("404 produces a long model lockout", () => {
    r.classifyAndRecord("p", "p#0", "ghost", { status: 404 });
    const snap = r.snapshot();
    assert.ok(snap.models["p::ghost"].lockedSecRemaining > 60);
  });

  test("5xx trips the provider breaker only at threshold", () => {
    assert.equal(r.classifyAndRecord("p", "p#0", "m", { status: 503 }), "provider");
    assert.equal(r.isProviderAvailable("p"), true, "one failure is not enough");
    r.classifyAndRecord("p", "p#0", "m", { status: 503 });
    r.classifyAndRecord("p", "p#0", "m", { status: 503 });
    assert.equal(r.isProviderAvailable("p"), false, "opens at 3");
  });
});

describe("resilience: recovery", () => {
  test("success clears every layer on that path", () => {
    r.classifyAndRecord("p", "p#0", "m", { status: 401 });
    r.classifyAndRecord("p", "p#0", "m", { status: 429 });
    assert.equal(r.isConnectionAvailable("p", "p#0"), false);
    assert.equal(r.isModelAvailable("p", "m"), false);
    r.recordSuccess("p", "p#0", "m");
    assert.equal(r.isConnectionAvailable("p", "p#0"), true);
    assert.equal(r.isModelAvailable("p", "m"), true);
  });

  test("model lockout expires lazily", async () => {
    r.lockOutModel("p", "m", "test", 40);
    // The advertised policy must be a rule that actually runs. modelLockoutSec
    // was 300 while neither path used 300: a 429 benches for 60s and a 404 for
    // 1800s, so the block described nothing, and MCP clients read it as fact.
    const pol = r.snapshot().policy;
    assert.equal(pol.modelLockoutSec, 60, "advertised model lockout must match the 429 path");
    assert.equal(pol.modelNotFoundLockoutSec, 1800, "advertised 404 lockout must match the 404 path");
    assert.equal(r.isModelAvailable("p", "m"), false);
    await new Promise((res) => setTimeout(res, 70));
    assert.equal(r.isModelAvailable("p", "m"), true);
  });

  test("connection cooldown expires lazily", async () => {
    r.coolDownConnection("p", "p#0", 40);
    assert.equal(r.isConnectionAvailable("p", "p#0"), false);
    await new Promise((res) => setTimeout(res, 70));
    assert.equal(r.isConnectionAvailable("p", "p#0"), true);
  });

  test("provider breaker half-opens after cooldown", () => {
    for (let i = 0; i < 3; i++) r.recordProviderFailure("p");
    assert.equal(r.isProviderAvailable("p"), false);
    const snap = r.snapshot();
    assert.equal(snap.providers.p.status, "OPEN");
  });
});

describe("resilience: snapshot", () => {
  test("omits expired entries", async () => {
    r.lockOutModel("p", "m", "test", 30);
    assert.equal(Object.keys(r.snapshot().models).length, 1);
    await new Promise((res) => setTimeout(res, 60));
    assert.equal(Object.keys(r.snapshot().models).length, 0);
  });

  test("never contains key material", () => {
    r.coolDownConnection("groq", "groq#0");
    const serialized = JSON.stringify(r.snapshot());
    assert.ok(!serialized.includes("sk-"));
    assert.ok(serialized.includes("groq#0"), "tracks by connection id, not key");
  });
});

describe("resilience: a caller's bad request is not a provider's fault", () => {
  // The fall-through used to catch every status it had not already named, so a
  // 400, 413 or 422 was booked as provider ill-health. Three malformed
  // requests from one caller opened the breaker on a lane that was answering
  // everyone else, and removed it for thirty seconds. The comment always said
  // "5xx / network / timeout"; the code did not.
  for (const [status, label] of [[400, "malformed"], [413, "payload too large"], [422, "unprocessable"]]) {
    test(`${status} (${label}) does not count against provider health`, () => {
      r.reset();
      const layer = r.classifyAndRecord("p", "p#0", "m", { status });
      assert.equal(layer, "request", "the caller's request is the smallest scope that explains this");
      assert.equal(r.snapshot().providers.p?.failures ?? 0, 0, "provider health untouched");
    });
  }

  test("three malformed requests leave a healthy breaker closed", () => {
    r.reset();
    for (let i = 0; i < 3; i++) r.classifyAndRecord("p", "p#0", "m", { status: 400 });
    assert.equal(r.isProviderAvailable("p"), true, "a healthy lane must survive a caller sending rubbish");
  });

  test("408 and 5xx still open it, because those are the provider", () => {
    for (const status of [408, 500, 502, 503]) {
      r.reset();
      for (let i = 0; i < 3; i++) r.classifyAndRecord("p", "p#0", "m", { status });
      assert.equal(r.isProviderAvailable("p"), false, `${status} must still trip the breaker`);
    }
  });
});
