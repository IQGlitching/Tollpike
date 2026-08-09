import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Before importing anything that reads settings. Without this the suite loads
// the developer's real data/settings.json, and the preview tests below write
// to it: that is how a run of `npm test` on this machine overwrote a live
// gateway key with null. Every test file that can reach updateSettings needs
// its own data directory.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tollpike-resilience-"));
process.env.TOLLPIKE_DATA_DIR = tmp;

const r = await import("../src/routing/resilience.js");

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

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

// "allow one probe" was a comment, not a behaviour: HALF_OPEN returned true to
// everyone, so it only held when requests arrived one at a time and each
// verdict landed before the next check. A concurrent burst all passed together
// and every one of them waited out the full timeout against a dead provider.
describe("resilience: half-open admits exactly one probe", () => {
  const P = "probe-test";
  const COOLDOWN_MS = 30_000;
  let realNow;

  beforeEach(() => {
    r.reset();
    realNow = Date.now;
  });

  const at = (offsetMs) => { Date.now = () => realNow() + offsetMs; };
  const restore = () => { Date.now = realNow; };

  const trip = () => {
    for (let i = 0; i < 3; i++) r.recordProviderFailure(P);
  };

  test("a burst arriving together yields one probe, not one each", () => {
    trip();
    assert.equal(r.isProviderAvailable(P), false, "the breaker must be open first");
    at(COOLDOWN_MS + 1_000);
    // None of these has recorded a verdict yet, which is what concurrency means.
    const allowed = Array.from({ length: 50 }, () => r.isProviderAvailable(P)).filter(Boolean).length;
    assert.equal(allowed, 1);
    restore();
  });

  test("listing providers does not consume the probe or move the breaker", () => {
    trip();
    at(COOLDOWN_MS + 1_000);
    for (let i = 0; i < 10; i++) r.canServe(P);
    // If canServe had claimed the slot, this would be 0.
    assert.equal(r.isProviderAvailable(P), true);
    restore();
  });

  test("canServe reports the truth without changing it", () => {
    trip();
    assert.equal(r.canServe(P), false, "open and inside the cooldown");
    at(COOLDOWN_MS + 1_000);
    assert.equal(r.canServe(P), true, "cooldown elapsed, a probe is due");
    restore();
  });

  test("a probe that never reports back does not bench the lane forever", () => {
    trip();
    at(COOLDOWN_MS + 1_000);
    assert.equal(r.isProviderAvailable(P), true, "probe goes out");
    assert.equal(r.isProviderAvailable(P), false, "and holds the slot");
    // The request was dropped: neither success nor failure was ever recorded.
    at(COOLDOWN_MS * 4);
    assert.equal(r.isProviderAvailable(P), true, "the next window may probe again");
    restore();
  });

  test("a successful probe reopens the lane for everyone", () => {
    trip();
    at(COOLDOWN_MS + 1_000);
    assert.equal(r.isProviderAvailable(P), true);
    r.recordSuccess(P, "key", "model");
    const allowed = Array.from({ length: 5 }, () => r.isProviderAvailable(P)).filter(Boolean).length;
    assert.equal(allowed, 5);
    restore();
  });

  test("a failed probe re-opens the breaker against the next caller", () => {
    trip();
    at(COOLDOWN_MS + 1_000);
    assert.equal(r.isProviderAvailable(P), true);
    r.recordProviderFailure(P);
    assert.equal(r.isProviderAvailable(P), false);
    restore();
  });
});

// The preview endpoint answers "what would this route do". It reported only
// hasKey and enabled, two of the six conditions skipReason applies, so a lane
// with an open breaker or spend past its cap previewed as ready to serve.
describe("routing preview reflects every condition the router skips on", () => {
  let buildCandidates, skipReason, settingsMod, cost;

  before(async () => {
    ({ buildCandidates, skipReason } = await import("../src/routing/router.js"));
    settingsMod = await import("../src/storage/settings.js");
    cost = await import("../src/storage/costTracker.js");
  });

  const laneFor = (id) =>
    buildCandidates("auto", { model: "auto", messages: [] }).find((c) => c.provider.id === id);

  // A provider that has a key in this process, so the "no API key" check does
  // not mask the conditions under test.
  const keyed = () =>
    buildCandidates("auto", { model: "auto", messages: [] }).find((c) => c.provider.available);

  const reasonFor = (lane) =>
    skipReason(lane.provider, settingsMod.getSettings(), lane.model, { claimProbe: false });

  test("an open breaker is visible in the preview", (t) => {
    const lane = keyed();
    if (!lane) return t.skip("no provider has a key in this environment");
    r.reset();
    assert.equal(reasonFor(lane), null, "should start contactable");
    for (let i = 0; i < 3; i++) r.recordProviderFailure(lane.provider.id);
    assert.match(reasonFor(laneFor(lane.provider.id)), /circuit open/);
    r.reset();
  });

  test("a provider over its monthly cap is visible in the preview", (t) => {
    const lane = keyed();
    if (!lane) return t.skip("no provider has a key in this environment");
    r.reset();
    const release = cost.reserveSpend(lane.provider.id, 5);
    settingsMod.updateSettings({ budgetCapsUsd: { [lane.provider.id]: 0.01 } });
    try {
      assert.match(reasonFor(laneFor(lane.provider.id)), /budget cap/);
    } finally {
      release();
      settingsMod.updateSettings({ budgetCapsUsd: {} });
    }
  });

  test("previewing never consumes the half-open probe", (t) => {
    const lane = keyed();
    if (!lane) return t.skip("no provider has a key in this environment");
    r.reset();
    const id = lane.provider.id;
    for (let i = 0; i < 3; i++) r.recordProviderFailure(id);
    const realNow = Date.now;
    Date.now = () => realNow() + 31_000;
    try {
      for (let i = 0; i < 5; i++) reasonFor(laneFor(id));
      // If any of those had claimed the slot, the real request would be denied.
      assert.equal(r.isProviderAvailable(id), true);
    } finally {
      Date.now = realNow;
      r.reset();
    }
  });
});
