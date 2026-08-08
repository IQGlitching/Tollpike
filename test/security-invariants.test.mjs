import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Some security properties are invisible to behavioural tests. A
// timing-unsafe string comparison returns exactly the same 401/200 as a
// safe one — only the timing differs, and timing assertions are far too
// flaky to gate CI on. These tests assert the *implementation* property
// instead.
//
// This suite exists because mutation testing found the gap: reverting the
// auth check to `token !== gatewayApiKey` passed all 100 behavioural
// tests. Structural assertions are the cheap, reliable guard.

const src = (rel) => fs.readFileSync(path.join(import.meta.dirname, "..", "src", rel), "utf-8");

describe("security invariants: constant-time comparison", () => {
  const auth = src("middleware/auth.js");

  test("auth uses safeCompare, not a raw equality operator", () => {
    assert.ok(auth.includes("safeCompare"), "must call safeCompare");
  });

  test("auth never compares the token with === or !==", () => {
    const offending = auth
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .filter((l) => /token\s*[!=]==|[!=]==\s*token/.test(l))
      .filter((l) => !l.includes('token = ') && !/token\s*=\s*header/.test(l));
    assert.deepEqual(offending, [], "token must never be compared with ===/!==");
  });

  test("safeCompare is backed by crypto.timingSafeEqual", () => {
    assert.ok(src("security/crypto.js").includes("timingSafeEqual"));
  });
});

describe("security invariants: no hardcoded fallback secret", () => {
  const crypto = src("security/crypto.js");

  test("encryption returns null key rather than defaulting when secret is unset", () => {
    assert.ok(
      /if\s*\(!secret\)\s*return null/.test(crypto),
      "must refuse to derive a key without TOLLPIKE_SECRET"
    );
  });

  test("no literal fallback secret in the crypto module", () => {
    const suspicious = /TOLLPIKE_SECRET\s*\|\|\s*["'`]/.test(crypto);
    assert.equal(suspicious, false, "must not fall back to a hardcoded passphrase");
  });

  test("salt is written with restrictive permissions", () => {
    assert.ok(crypto.includes("0o600"), "salt file must not be world-readable");
  });
});

describe("security invariants: secrets never enter logs or state", () => {
  test("resilience tracks connections by id, never by key material", () => {
    const res = src("routing/resilience.js");
    assert.ok(!/\.key\b/.test(res), "resilience must not touch connection.key");
  });

  // CHANGED, deliberately — read this before "fixing" it back.
  //
  // The original invariant was "the rate limiter stores only slice(7, 15)
  // of the bearer token". That kept whole secrets out of the Map, which is
  // necessary, but it is not sufficient and the assertion hid the gap: a
  // raw prefix is *derivable by an outsider*. Generated keys all start
  // `tpk_`, so an unauthenticated caller could guess the remaining few
  // characters, name the operator's bucket, and drain it — and because the
  // limiter ran ahead of auth, they never needed a valid key to do it.
  //
  // The property that actually matters is: bucket identity must not be
  // recoverable from the token by anyone who doesn't already have it. An
  // HMAC under a per-process random key satisfies both that and the
  // original no-key-material requirement.
  test("rate limiter derives bucket identity via HMAC, never a raw token substring", () => {
    const rl = src("middleware/rateLimit.js");
    assert.ok(rl.includes("fingerprint("), "bucket identity must come from fingerprint()");
    assert.ok(
      !/slice\(\s*7\s*,\s*15\s*\)/.test(rl),
      "a raw prefix of the token is guessable and must not be the bucket id"
    );
    assert.ok(
      src("security/crypto.js").includes("createHmac"),
      "fingerprint() must be keyed, not a bare hash"
    );
  });

  test("auth runs before the rate limiter", () => {
    const server = src("server.js");
    const authAt = server.indexOf('app.use("/v1", requireGatewayKey)');
    const rlAt = server.indexOf('app.use("/v1", rateLimiter.rateLimit)');
    assert.ok(authAt !== -1 && rlAt !== -1, "/v1 must mount both middlewares");
    assert.ok(
      authAt < rlAt,
      "auth must run first, or an unauthenticated caller reaches token-derived rate-limit state"
    );
  });

  test("panel state never serializes provider API keys", () => {
    const server = src("server.js");
    const stateBlock = server.slice(
      server.indexOf('app.get("/api/panel/state"'),
      server.indexOf('app.post("/api/panel/providers')
    );
    assert.ok(!/\bapiKey\b/.test(stateBlock), "panel state must not include apiKey");
    assert.ok(!/connection\.key|\.connections\[0\]\.key/.test(stateBlock));
  });
});

describe("security invariants: guardrail correctness guards", () => {
  test("Luhn validation is actually applied to candidate matches", () => {
    const g = src("security/guardrails.js");
    assert.ok(/rule\.validate\s*&&\s*!rule\.validate\(match\)/.test(g),
      "validate() must gate redaction or card detection produces false positives");
  });

  // CHANGED, deliberately — read this before "fixing" it back.
  //
  // The original invariant was "injection scanning is restricted to user
  // turns", justified by not wanting to flag the operator's own system
  // prompt. That reasoning is sound for `system` and `assistant`. It does
  // not transfer to `tool`: tool results carry text from web pages, files
  // and APIs the operator does not control, which makes them the primary
  // indirect-injection vector — and they were the one role never scanned.
  //
  // The invariant that survives is the narrow one: never scan the
  // operator's own turns. Untrusted roles must be scanned.
  test("injection scanning covers untrusted roles and skips operator-authored ones", async () => {
    const { isScannedRole } = await import("../src/security/guardrails.js");
    assert.equal(isScannedRole("user"), true);
    assert.equal(isScannedRole("tool"), true, "tool output is untrusted input, not operator intent");
    assert.equal(isScannedRole("system"), false, "the system prompt is the operator's own text");
    assert.equal(isScannedRole("assistant"), false);
  });
});

describe("security invariants: control-plane exposure", () => {
  test("server binds loopback unless explicitly overridden", () => {
    const server = src("server.js");
    assert.ok(
      /BIND_HOST\s*=\s*process\.env\.BIND_HOST\s*\|\|\s*["']127\.0\.0\.1["']/.test(server),
      "default bind must be loopback; app.listen(PORT) alone binds every interface"
    );
    assert.ok(
      /app\.listen\(\s*PORT\s*,\s*BIND_HOST/.test(server),
      "listen() must be passed the host, or the default is ignored"
    );
  });

  test("a Host-header guard is mounted ahead of the routes", () => {
    const server = src("server.js");
    const guardAt = server.indexOf("app.use(hostGuard)");
    assert.ok(guardAt !== -1, "hostGuard must be mounted");
    assert.ok(guardAt < server.indexOf('app.get("/health"'), "hostGuard must run before any route");
  });

  test("the egress proxy endpoint validates both provider id and URL", () => {
    const server = src("server.js");
    const block = server.slice(
      server.indexOf('app.post("/api/panel/proxy"'),
      server.indexOf('app.post("/api/panel/generate-key"')
    );
    assert.ok(block.includes("validateProxyUrl"), "proxy URL must be validated");
    assert.ok(/providers\.find/.test(block), "providerId must be checked against known providers");
  });
});

describe("security invariants: stored credentials", () => {
  test("the gateway key is encrypted at rest when a secret is available", () => {
    const settings = src("storage/settings.js");
    assert.ok(settings.includes("ENCRYPTED_FIELDS"), "must declare which fields are encrypted");
    assert.ok(/gatewayApiKey/.test(settings) && settings.includes("encrypt("),
      "gatewayApiKey must pass through encrypt() before being written");
  });

  test("settings are written atomically with restrictive permissions", () => {
    const settings = src("storage/settings.js");
    assert.ok(settings.includes("renameSync"), "write must be temp-file + rename, not in-place");
    assert.ok(settings.includes("0o600"), "settings hold the gateway key and must not be world-readable");
  });

  test("the panel reports real encryption state, not merely that a secret is set", () => {
    const server = src("server.js");
    assert.ok(server.includes("keyEncryptedAtRest"),
      "panel state must distinguish 'a secret exists' from 'the key is encrypted'");
  });
});
