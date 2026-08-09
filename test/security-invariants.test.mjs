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

describe("security invariants: every routing surface applies the guardrails", () => {
  // The rate limiter is mounted on /mcp and /a2a for a stated reason:
  // completions_chat and the smart-routing skill both route real requests, so
  // exempting them "would leave a way around the only control that stops a
  // runaway agent loop". Exactly the same argument applies to PII redaction
  // and injection scanning, and those two surfaces were exempt from both:
  // they called routeChatCompletion directly, bypassing prepare(). An
  // operator who switched redaction on got it on the surface a human types
  // into and not on the one an agent drives, which is the less supervised of
  // the two.
  //
  // Structural, not behavioural, because the failure mode is someone adding a
  // sixth call site later. A behavioural test only covers the paths it knows.
  for (const rel of ["mcp/scopes.js", "a2a/skills.js"]) {
    test(`${rel} guards every request it routes`, () => {
      const code = src(rel);
      const routes = (code.match(/routeChatCompletion\(/g) || []).length;
      if (routes === 0) return; // nothing routed here, nothing to guard

      assert.ok(
        code.includes('from "../security/policy.js"'),
        `${rel} routes requests but does not import the guardrail policy`
      );
      const guards = (code.match(/guardRouted\(/g) || []).length;
      assert.ok(
        guards >= routes,
        `${rel} routes ${routes} request(s) but only guards ${guards}`
      );
      assert.ok(
        code.includes("guard.blocked"),
        `${rel} must honour a blocked verdict rather than routing anyway`
      );
    });
  }

  test("the guardrail policy is resolved in exactly one place", () => {
    // Two surfaces resolving `settings.redactPii` independently is how they
    // drift apart, which is how one of them ended up resolving it never.
    const policy = src("security/policy.js");
    assert.ok(policy.includes("redactPii") && policy.includes("injectionMode"),
      "policy.js is the single place stored settings become a guardrail decision");
    assert.ok(src("security/guardrails.js").trim().length > 0);
    assert.ok(
      !/^import /m.test(src("security/guardrails.js")),
      "guardrails.js stays a pure transform with no imports, so it remains trivially testable"
    );
  });
});

describe("invariants: every non-streaming dialect shares one cache", () => {
  // The cache was wired into /v1/chat/completions only, so /v1/messages,
  // /v1/responses and /api/chat each paid full price for a question another
  // dialect had already answered. Nothing was incorrect (a miss is always
  // safe) but "cross-provider response caching" was narrower in practice than
  // it reads. The key is built from the normalised internal payload, so the
  // four dialects genuinely share entries rather than keeping four private
  // caches.
  const server = src("server.js");

  test("each dialect converter is reachable from a cache hit", () => {
    // Plain substring rather than a regex. The claim is exactly "this
    // converter is applied to a cached entry", and building that as a regex
    // inside a template literal only adds escaping to get wrong, which is
    // how the first version of this test managed to fail against correct code.
    for (const conv of ["toAnthropicResponse", "toResponsesResponse", "toOllamaResponse"]) {
      assert.ok(
        server.includes(conv + "(cached.hit"),
        conv + " must be able to serve a cached entry"
      );
    }
  });

  test("every dialect that can cache also stores what it routed", () => {
    // Call sites only. The bare name also matches the function definition.
    const lookups = (server.match(/const cached = cacheFor\(req, body/g) || []).length;
    const stores = (server.match(/cache\.set\(/g) || []).length;
    assert.equal(lookups, 3, "the three non-chat dialects each perform a lookup");
    // Three dialect stores plus the original chat/completions store.
    assert.ok(stores >= 4, `expected at least 4 cache.set call sites, found ${stores}`);
  });

  test("the cache key is built from the routed payload, not the wire format", () => {
    // Keying on the inbound body would give four private caches that never
    // share, which is the thing this is meant to avoid.
    assert.match(server, /cacheFor\(req, body, prepared\.payload\)/,
      "dialects must key on the normalised payload");
    const cacheSrc = src("storage/responseCache.js");
    for (const field of ["model", "messages", "tools", "tool_choice", "max_tokens", "caller"]) {
      assert.ok(cacheSrc.includes(field), `${field} belongs in the key`);
    }
  });
});
