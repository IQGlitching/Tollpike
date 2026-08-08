import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Resilience over real HTTP.
//
// test/resilience.test.mjs already pins the classifier: given a 401 it cools a
// connection, given a 429 it locks a model. That is the rule. It says nothing
// about whether a real upstream returning 401 ever REACHES that rule — the
// adapter has to surface `status`, the router has to hand it to
// classifyAndRecord with the right connection id, and the snapshot has to carry
// the result out to the panel. Every one of those is wiring, and wiring is
// exactly what a unit test of the rule cannot see.
//
// So this drives a stand-in upstream that returns a chosen status code, routes
// a genuine request at it through the real router, and asserts on the real
// snapshot. It is the layer that would have caught an adapter swallowing the
// status, or the panel being handed a field that is never populated.
//
// No vendor, no network, no money: the upstream is a local server on an
// ephemeral port, and the provider's baseURL is repointed at it.

// Ambient credentials are suppressed before anything reads them. An explicitly
// named env file is authoritative in src/env.js, so a path that does not exist
// means no credentials from ~/.tollpike/.env or the repo's own .env — see the
// same guard in gateway.e2e.test.mjs for why one mechanism is not enough.
process.env.TOLLPIKE_ENV_FILE = path.join(os.tmpdir(), "tollpike-no-such-env-file");
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tollpike-res-http-"));
process.env.TOLLPIKE_DATA_DIR = DATA_DIR;

// Dynamic, so the env above is in place before the module graph loads. Static
// imports hoist; these do not.
const { getProvider, applyCredential } = await import("../src/providers/registry.js");
const resilience = await import("../src/routing/resilience.js");
const { routeChatCompletion } = await import("../src/routing/router.js");

const PROVIDER = "lmstudio";      // local runtime: needs no real credential
const MODEL = "local-model";      // its one configured model

let server;
let mode = "ok";
let hits = [];
let originalBaseURL;

const ask = (content) =>
  routeChatCompletion({
    // Pinned to one provider. resolveExplicit() returns exactly that provider,
    // so a failure here can never fall through to a lane that might hold a
    // developer's real key — which is what keeps `npm test` free.
    model: `${PROVIDER}/${MODEL}`,
    messages: [{ role: "user", content }]
  });

// Every request needs a distinct prompt: the response cache is exact-match on
// the message body, and an identical second request would be served from memory
// without ever reaching the upstream. That is correct cache behaviour and it
// silently defeats a failure test.
let n = 0;
const unique = () => `probe-${Date.now()}-${n++}`;

const expectFailure = async () => {
  await assert.rejects(() => ask(unique()));
};

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      hits.push({ url: req.url, key: (req.headers.authorization || "").replace(/^Bearer\s+/i, "") });
      const send = (code, payload) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (mode !== "ok") return send(Number(mode), { error: { message: `mock ${mode}` } });
      send(200, {
        id: "chatcmpl-mock",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: MODEL,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 }
      });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const provider = getProvider(PROVIDER);
  originalBaseURL = provider.baseURL;
  provider.baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  // Two connections, so "one key is benched and the other keeps serving" is
  // something this suite can actually observe rather than assert about a
  // provider that only ever had one.
  applyCredential(PROVIDER, "key-alpha,key-beta");
  assert.equal(getProvider(PROVIDER).connections.length, 2, "fixture needs two connections");
});

after(async () => {
  if (originalBaseURL) getProvider(PROVIDER).baseURL = originalBaseURL;
  resilience.reset();
  await new Promise((r) => server.close(r));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  resilience.reset();
  hits = [];
  mode = "ok";
});

describe("resilience over HTTP: an upstream status becomes isolation state", () => {
  test("a healthy upstream serves and isolates nothing", async () => {
    const { response } = await ask(unique());
    assert.equal(response.choices[0].message.content, "ok");
    const snap = resilience.snapshot();
    assert.deepEqual(snap.connections, {}, "nothing cooled");
    assert.deepEqual(snap.models, {}, "nothing locked");
    assert.equal(resilience.isProviderAvailable(PROVIDER), true);
  });

  test("401 benches the credential that was rejected, not the lane", async () => {
    mode = "401";
    await expectFailure();

    const snap = resilience.snapshot();
    assert.equal(resilience.isProviderAvailable(PROVIDER), true, "a bad key is not a dead provider");
    assert.equal(resilience.isModelAvailable(PROVIDER, MODEL), true, "the model is fine");
    assert.equal(Object.keys(snap.connections).length, 1, "exactly the rejected connection is cooling");
    assert.equal(
      resilience.isConnectionAvailable(PROVIDER, `${PROVIDER}#1`), true,
      "the provider's other credential is untouched"
    );
    // One attempt spends one connection: there is no inner retry across a
    // provider's keys, so a 401 costs the caller this request. What the bench
    // buys is that the NEXT request skips the bad key — see below.
    assert.equal(hits.length, 1, "a pinned request makes one attempt");
  });

  test("the benched credential is skipped on the next request, not this one", async () => {
    mode = "401";
    await expectFailure();
    const firstKey = hits[0].key;

    // Second request: the cooled connection is passed over, and the other one
    // is dialled. That is the whole value of cooling a connection rather than
    // the lane — the lane is still reachable through its remaining key.
    mode = "ok";
    const { response } = await ask(unique());
    assert.equal(response.choices[0].message.content, "ok");
    assert.equal(hits.length, 2);
    assert.notEqual(hits[1].key, firstKey, "moved on to the credential that was not benched");
  });

  test("a single bad key leaves the provider's other key serving", async () => {
    // Only the first connection is poisoned, so the retry must succeed.
    resilience.coolDownConnection(PROVIDER, `${PROVIDER}#0`);
    mode = "ok";
    const { response } = await ask(unique());
    assert.equal(response.choices[0].message.content, "ok");
    assert.equal(hits.length, 1, "went straight to the healthy connection");
    assert.equal(hits[0].key, "key-beta", "used the connection that was not benched");
  });

  test("429 locks one model and leaves the credential and the lane alone", async () => {
    mode = "429";
    await expectFailure();

    assert.equal(resilience.isModelAvailable(PROVIDER, MODEL), false, "this model is benched");
    assert.equal(resilience.isModelAvailable(PROVIDER, "some-other-model"), true, "siblings serve");
    assert.equal(resilience.isProviderAvailable(PROVIDER), true, "the lane stays up");
    assert.equal(
      resilience.isConnectionAvailable(PROVIDER, `${PROVIDER}#0`), true,
      "a rate limit says nothing about the credential"
    );
    assert.equal(resilience.snapshot().models[`${PROVIDER}::${MODEL}`].reason, "rate_limit");
  });

  test("404 produces a much longer model lockout than 429", async () => {
    mode = "429";
    await expectFailure();
    const short = resilience.snapshot().models[`${PROVIDER}::${MODEL}`].lockedSecTotal;

    resilience.reset();
    mode = "404";
    await expectFailure();
    const long = resilience.snapshot().models[`${PROVIDER}::${MODEL}`];

    assert.equal(long.reason, "not_found");
    assert.ok(long.lockedSecTotal > short, "a model that does not exist will not appear on a retry");
  });

  test("5xx opens the breaker only once the threshold is reached", async () => {
    mode = "500";
    const { providerFailureThreshold } = resilience.snapshot().policy;

    for (let i = 1; i < providerFailureThreshold; i++) {
      await expectFailure();
      assert.equal(
        resilience.isProviderAvailable(PROVIDER), true,
        `still up after ${i} failure(s) — the breaker must not be a hair trigger`
      );
    }

    await expectFailure();
    assert.equal(resilience.isProviderAvailable(PROVIDER), false, "opens at the threshold");
    assert.equal(resilience.snapshot().providers[PROVIDER].status, "OPEN");
  });

  test("an open breaker is not retried, so the upstream stops being called", async () => {
    mode = "500";
    const { providerFailureThreshold } = resilience.snapshot().policy;
    for (let i = 0; i < providerFailureThreshold; i++) await expectFailure();
    assert.equal(resilience.isProviderAvailable(PROVIDER), false);

    const before = hits.length;
    await expectFailure();
    assert.equal(hits.length, before, "a lane that is out does not get dialled");
  });
});

describe("the snapshot carries everything the panel renders", () => {
  test("a cooling connection reports remaining AND total", async () => {
    mode = "401";
    await expectFailure();
    const entry = Object.values(resilience.snapshot().connections)[0];
    assert.ok(entry.cooldownSecRemaining > 0);
    // Without the total, a countdown can print "47s left" without saying left
    // of what, and the panel's progress bar has no denominator.
    assert.ok(entry.cooldownSecTotal > 0, "total must travel with remaining");
    assert.ok(entry.cooldownSecRemaining <= entry.cooldownSecTotal);
    assert.ok(entry.failures >= 1);
  });

  test("a locked model reports remaining AND total", async () => {
    mode = "429";
    await expectFailure();
    const entry = resilience.snapshot().models[`${PROVIDER}::${MODEL}`];
    assert.ok(entry.lockedSecRemaining > 0);
    assert.ok(entry.lockedSecTotal > 0, "total must travel with remaining");
    assert.ok(entry.lockedSecRemaining <= entry.lockedSecTotal);
  });

  test("an open breaker reports when it will next be probed", async () => {
    mode = "500";
    const { providerFailureThreshold, providerCooldownSec } = resilience.snapshot().policy;
    for (let i = 0; i < providerFailureThreshold; i++) await expectFailure();

    const entry = resilience.snapshot().providers[PROVIDER];
    assert.equal(entry.status, "OPEN");
    assert.ok(entry.probeInSecRemaining > 0, "an open lane must say how long it sits out");
    assert.ok(entry.probeInSecRemaining <= providerCooldownSec);
  });

  test("a closed breaker has nothing to wait for", () => {
    const entry = resilience.snapshot().providers[PROVIDER];
    assert.equal(entry?.probeInSecRemaining ?? null, null);
  });

  test("policy travels, so the panel need not restate the thresholds", () => {
    const { policy } = resilience.snapshot();
    for (const k of [
      "providerFailureThreshold",
      "providerCooldownSec",
      "connectionCooldownSec",
      "modelLockoutSec"
    ]) {
      assert.equal(typeof policy[k], "number", `${k} must be reported`);
      assert.ok(policy[k] > 0);
    }
  });
});

describe("a pinned request never wanders to another lane", () => {
  test("failure on a pinned provider fails, rather than falling back", async () => {
    mode = "500";
    await assert.rejects(
      () => ask(unique()),
      // If this ever starts resolving, a test run could dispatch to whichever
      // lane happens to hold a real credential. That is the guard.
      (err) => {
        assert.ok(err instanceof Error);
        return true;
      }
    );
    assert.ok(
      hits.every((h) => h.key === "key-alpha" || h.key === "key-beta"),
      "only the pinned provider's own connections were dialled"
    );
  });
});
