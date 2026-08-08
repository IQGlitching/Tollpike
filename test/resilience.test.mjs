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
