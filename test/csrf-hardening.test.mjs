import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Regression tests for the second hardening pass — the findings the audit
// turned up after the first one. Each fails against the code as it was.
//
// The theme running through these: the first pass secured the surfaces an
// attacker reaches DIRECTLY, and left the ones they reach THROUGH THE
// OPERATOR'S BROWSER. hostGuard is the clearest case — it was written against
// DNS rebinding and is correct about rebinding, but a form post to an IP
// literal never rebinds anything and sailed straight past it.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tollpike-csrf-"));
process.env.TOLLPIKE_DATA_DIR = tmp;

// Line endings are normalised on read. git checks these files out with CRLF
// on Windows, and every assertion below that embeds a newline in a search
// string silently stops matching, so a fresh clone went red on correct code.
const src = (rel) =>
  fs.readFileSync(path.join(import.meta.dirname, "..", "src", rel), "utf-8")
    .replace(/\r\n/g, "\n");

const { isCrossSite, csrfGuard } = await import("../src/middleware/csrf.js");
const { rewritePathToken } = await import("../src/middleware/pathToken.js");
const { isPricingVerified } = await import("../src/providers/registry.js");
const { listCombos, comboName } = await import("../src/routing/strategies.js");

// Minimal Express-shaped request. `get` is case-insensitive like the real one.
const req = (method, headers = {}) => {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { method, headers: lower, get: (name) => lower[name.toLowerCase()] };
};

describe("csrf: cross-site provenance detection", () => {
  test("a browser form post from another origin is cross-site", () => {
    assert.equal(
      isCrossSite(req("POST", { "Sec-Fetch-Site": "cross-site", Host: "127.0.0.1:20128" })),
      true
    );
  });

  test("same-site is still not same-origin and must be rejected", () => {
    // A subdomain of a domain the operator trusts is a different origin, and
    // "same-site" is precisely the header value that says so.
    assert.equal(isCrossSite(req("POST", { "Sec-Fetch-Site": "same-site" })), true);
  });

  test("the panel's own fetch calls are same-origin and pass", () => {
    assert.equal(isCrossSite(req("POST", { "Sec-Fetch-Site": "same-origin" })), false);
  });

  test("a typed URL or bookmark (Sec-Fetch-Site: none) passes", () => {
    assert.equal(isCrossSite(req("POST", { "Sec-Fetch-Site": "none" })), false);
  });

  test("falls back to Origin when Sec-Fetch metadata is absent", () => {
    assert.equal(
      isCrossSite(req("POST", { Origin: "https://evil.example", Host: "127.0.0.1:20128" })),
      true
    );
    assert.equal(
      isCrossSite(req("POST", { Origin: "http://127.0.0.1:20128", Host: "127.0.0.1:20128" })),
      false
    );
  });

  test('a sandboxed iframe\'s literal "null" Origin is not treated as same-origin', () => {
    assert.equal(isCrossSite(req("POST", { Origin: "null", Host: "127.0.0.1:20128" })), true);
  });

  test("an unparseable Origin gets no benefit of the doubt", () => {
    assert.equal(isCrossSite(req("POST", { Origin: "%%%", Host: "127.0.0.1:20128" })), true);
  });

  // The deliberate limit of this control, asserted so it is not "fixed" into
  // something that breaks every SDK and CLI client on the planet.
  test("a non-browser client sending neither header passes", () => {
    assert.equal(isCrossSite(req("POST", { Host: "127.0.0.1:20128" })), false);
  });
});

describe("csrf: the guard middleware", () => {
  const run = (request) => {
    let status = null;
    let body = null;
    let nexted = false;
    csrfGuard(
      request,
      {
        status(code) {
          status = code;
          return this;
        },
        json(payload) {
          body = payload;
          return this;
        }
      },
      () => {
        nexted = true;
      }
    );
    return { status, body, nexted };
  };

  test("blocks a cross-site state-changing request with 403", () => {
    const r = run(req("POST", { "Sec-Fetch-Site": "cross-site" }));
    assert.equal(r.nexted, false, "must not reach the handler");
    assert.equal(r.status, 403);
    assert.match(r.body.error, /Cross-site/);
  });

  test("allows cross-site GET — the response is unreadable without CORS anyway", () => {
    assert.equal(run(req("GET", { "Sec-Fetch-Site": "cross-site" })).nexted, true);
  });

  // PUT and DELETE matter here: /api/panel/combos/:name uses both, so guarding
  // only POST would leave saved routing config writable cross-site.
  for (const method of ["POST", "PUT", "DELETE"]) {
    test(`guards ${method}`, () => {
      assert.equal(run(req(method, { "Sec-Fetch-Site": "cross-site" })).nexted, false);
    });
  }
});

describe("csrf: mount order and coverage", () => {
  const server = src("server.js");

  test("the guard runs before auth, because auth is a no-op when no key is set", () => {
    const csrfAt = server.indexOf('app.use("/v1", csrfGuard)');
    const authAt = server.indexOf('app.use("/v1", requireGatewayKey)');
    assert.ok(csrfAt !== -1, "csrfGuard must be mounted on /v1");
    assert.ok(authAt !== -1);
    assert.ok(csrfAt < authAt, "the whole point is to cover the unauthenticated default");
  });

  test("every state-changing surface is covered, not just the panel", () => {
    for (const mount of ["/v1", "/api", "/mcp", "/a2a"]) {
      assert.ok(
        server.includes(`app.use("${mount}", csrfGuard)`),
        `${mount} must be behind the cross-site guard`
      );
    }
  });
});

describe("mcp: unauthenticated HTTP transport defaults to read-only", () => {
  const server = src("server.js");

  test("read-only is derived from whether a gateway key is set", () => {
    assert.ok(
      /function mcpReadOnly\(\)/.test(server),
      "the mode must be computed, not a flat process.env read"
    );
    assert.ok(
      /return !getSettings\(\)\.gatewayApiKey/.test(server),
      "no key must mean read-only — 100+ tools reachable unauthenticated is a remote control"
    );
  });

  test("MCP_READ_ONLY=false is an explicit opt back in", () => {
    assert.ok(/MCP_READ_ONLY === "false"/.test(server));
  });

  test("the transport resolves the mode per request, not once at mount", async () => {
    const mcp = src("mcp/server.js");
    assert.ok(mcp.includes("resolveReadOnly"), "must have a resolver");
    assert.ok(
      /createMcpServer\(\{ readOnly: resolveReadOnly\(\) \}\)/.test(mcp),
      "setting a key from the panel must take effect without a restart"
    );
  });

  test("mutating tools are refused, not merely hidden, in read-only mode", async () => {
    const { callTool } = await import("../src/mcp/scopes.js");
    await assert.rejects(
      () => callTool("services_start", { id: "bifrost" }, { readOnly: true }),
      /read-only/,
      "hiding a tool from the list leaves it callable by name"
    );
  });
});

describe("cloud agents: task ids cannot rewrite the vendor URL", () => {
  const { DRIVERS } = { DRIVERS: null }; // driver calls need a key; test the validator through them

  test("path traversal in a task id is rejected before any request is sent", async () => {
    const cloud = await import("../src/agents/cloud.js");
    process.env.CURSOR_API_KEY = "test-key-not-used";
    const result = await cloud.getTask("cursor", "../../admin");
    assert.equal(result.ok, false);
    assert.equal(result.status, 400, "must fail closed as a validation error, not a 502");
    assert.match(result.error, /Invalid task id/);
    delete process.env.CURSOR_API_KEY;
  });

  test("a query-string injection in a task id is rejected", async () => {
    const cloud = await import("../src/agents/cloud.js");
    process.env.CURSOR_API_KEY = "test-key-not-used";
    for (const bad of ["x?admin=1", "x#frag", "x/../../y", "a b", ""]) {
      const result = await cloud.getTask("cursor", bad);
      assert.equal(result.ok, false, `"${bad}" must be rejected`);
      assert.equal(result.status, 400, `"${bad}" must be a 400`);
    }
    delete process.env.CURSOR_API_KEY;
  });

  test("a 400 does not carry the misleading 'vendor moved their API' hint", async () => {
    const cloud = await import("../src/agents/cloud.js");
    process.env.CURSOR_API_KEY = "test-key-not-used";
    const result = await cloud.getTask("cursor", "../../admin");
    assert.equal(result.hint, undefined, "nothing was sent, so the vendor is not the suspect");
    delete process.env.CURSOR_API_KEY;
  });

  test("every vendor URL interpolation goes through the validator", () => {
    const cloud = src("agents/cloud.js");
    // Any `${id}` still sitting raw in a template literal is the bug returning.
    const raw = cloud
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .filter((l) => /\$\{baseURL\}[^`]*\$\{id\}/.test(l));
    assert.deepEqual(raw, [], "task ids must be validated/encoded, never interpolated raw");
  });

  test("Jules accepts both id spellings but rebuilds the prefix itself", async () => {
    const cloud = await import("../src/agents/cloud.js");
    process.env.JULES_API_KEY = "test-key-not-used";
    // `sessions/../../x` must not survive prefix-stripping into a traversal.
    const result = await cloud.getTask("jules", "sessions/../../x");
    assert.equal(result.status, 400);
    delete process.env.JULES_API_KEY;
  });
});

describe("path token: malformed input", () => {
  test("a bad percent-escape falls through instead of throwing a 500", () => {
    assert.doesNotThrow(() => rewritePathToken("/key/%/v1/models"));
    assert.equal(rewritePathToken("/key/%/v1/models"), null);
  });

  test("a well-formed encoded token still decodes", () => {
    assert.deepEqual(rewritePathToken("/key/tpk%5Fabc/v1/models"), {
      token: "tpk_abc",
      path: "/v1/models"
    });
  });

  test("the version segment is still normalised", () => {
    assert.equal(rewritePathToken("/vscode/k/chat/completions").path, "/v1/chat/completions");
    assert.equal(rewritePathToken("/vscode/k/v1/chat/completions").path, "/v1/chat/completions");
  });
});

describe("combos: object keys that mean something to JavaScript", () => {
  test("comboName rejects names that shadow object internals", () => {
    // The character filter alone does not catch this: "constructor" is already
    // lowercase a-z and passes straight through it.
    assert.equal(comboName("constructor"), "");
    assert.equal(comboName("prototype"), "");
    assert.equal(comboName("__proto__"), "--proto--", "non-alphanumerics are stripped to a safe distinct name");
  });

  test("ordinary combo names are untouched", () => {
    assert.equal(comboName("free-first"), "free-first");
    assert.equal(comboName("My Combo"), "my-combo");
  });

  // settings.combos is in the MCP settings_patch allowlist, so a whole combos
  // object can be written WITHOUT passing through comboName. That is the path
  // this guards.
  test("a hostile combos object cannot set the returned object's prototype", () => {
    const hostile = JSON.parse('{"__proto__": {"evil-combo": {"tiers": []}}}');
    const merged = listCombos(hostile);
    assert.equal(
      merged["evil-combo"],
      undefined,
      "an unsaved combo name must not resolve through a poisoned prototype"
    );
    assert.equal(Object.getPrototypeOf(merged)?.["evil-combo"], undefined);
  });

  test("a combo named constructor cannot shadow a real property", () => {
    const merged = listCombos(JSON.parse('{"constructor": {"tiers": []}}'));
    assert.equal(merged.constructor, undefined, "null-prototype base, and the name is skipped");
  });

  test("global Object.prototype is never reachable from this path", () => {
    listCombos(JSON.parse('{"__proto__": {"polluted": true}}'));
    assert.equal({}.polluted, undefined);
  });

  test("built-ins and legitimate custom combos still work", () => {
    assert.ok(Object.keys(listCombos({})).length >= 8, "built-in combos survive the null-prototype base");
    assert.equal(listCombos({ mine: { tiers: [] } }).mine.custom, true);
  });
});

describe("json api: unmatched routes", () => {
  test("a 404 is JSON, not Express's built-in HTML page", () => {
    const server = src("server.js");
    const notFoundAt = server.indexOf("app.use((req, res) => {");
    const errorHandlerAt = server.indexOf("app.use((err, req, res, next) => {\n  console.error(`[server] unhandled error");
    assert.ok(notFoundAt !== -1, "a 404 handler must exist — every client here parses JSON");
    assert.ok(
      notFoundAt < errorHandlerAt,
      "the 404 handler must precede the error handler, or Express treats it as one"
    );
  });

  test("the 404 body does not reflect the raw request path back", () => {
    const server = src("server.js");
    const block = server.slice(server.indexOf("app.use((req, res) => {"), server.indexOf("// Catch-all"));
    assert.ok(/req\.path\.slice\(/.test(block), "the echoed path must be length-capped");
    assert.ok(!/req\.originalUrl|req\.url\b/.test(block), "query strings can carry a key — do not echo them");
  });
});

describe("memory: the injection filter reports what it withheld", () => {
  test("hydrate returns the injected count, not the retrieved count", () => {
    const index = src("memory/index.js");
    assert.ok(
      /recalled: scanned\.length/.test(index),
      "reporting found.results.length made a filtered recall look complete"
    );
    assert.ok(/droppedForInjection,/.test(index), "the drop count must survive to the caller");
    assert.ok(/ids: scanned\.map/.test(index), "ids must describe what was injected");
  });

  test("recalled memories are scanned and dropped regardless of injectionMode", () => {
    const index = src("memory/index.js");
    assert.ok(index.includes("detectInjection"), "recall lands in a system message and must be scanned");
    // The guard must not be gated on the operator's flag — flagging after the
    // fact still lets the payload reach the model with system authority.
    const block = index.slice(index.indexOf("const scanned ="), index.indexOf("if (scanned.length === 0)"));
    assert.ok(!/injectionMode/.test(block), "this guard is unconditional by design");
  });

  test("the withheld count is surfaced on the response", () => {
    assert.ok(
      src("server.js").includes("X-Tollpike-Memory-Dropped-Injection"),
      "a guard that fires silently cannot be operated"
    );
  });
});

describe("pricing trust: only real provenance counts as verified", () => {
  test("an ISO date and n/a are verified", () => {
    assert.equal(isPricingVerified({ pricingVerified: "2026-08-08" }), true);
    assert.equal(isPricingVerified({ pricingVerified: "n/a" }), true);
  });

  test("false and absent are not verified", () => {
    assert.equal(isPricingVerified({ pricingVerified: false }), false);
    assert.equal(isPricingVerified({}), false);
  });

  // The actual bug: `typeof value === "string"` read these as verified, which
  // silently suppressed the budget-cap warning that says the cap may not fire.
  test("a string that does not mean verified is not verified", () => {
    for (const value of ["false", "unverified", "no", "TODO", ""]) {
      assert.equal(
        isPricingVerified({ pricingVerified: value }),
        false,
        `"${value}" must not read as verified`
      );
    }
  });

  test("the real config still classifies as before", async () => {
    const { providers } = await import("../src/providers/registry.js");
    const verified = providers.filter(isPricingVerified).map((p) => p.id);
    assert.ok(verified.includes("openai"), "dated entries stay verified");
    assert.ok(verified.includes("ollama"), 'local "n/a" entries stay verified');
    assert.ok(!verified.includes("cerebras"), "false entries stay unverified");
  });
});
