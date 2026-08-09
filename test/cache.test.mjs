import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as cache from "../src/storage/responseCache.js";

beforeEach(() => cache.clear());

describe("responseCache: keying", () => {
  test("identical requests produce identical keys", () => {
    const a = { model: "auto", messages: [{ role: "user", content: "hi" }] };
    assert.equal(cache.cacheKey(a), cache.cacheKey({ ...a }));
  });
  test("differing messages produce differing keys", () => {
    const k1 = cache.cacheKey({ model: "auto", messages: [{ role: "user", content: "a" }] });
    const k2 = cache.cacheKey({ model: "auto", messages: [{ role: "user", content: "b" }] });
    assert.notEqual(k1, k2);
  });
  test("tools participate in the key", () => {
    const base = { model: "auto", messages: [] };
    const withTools = { ...base, tools: [{ type: "function", function: { name: "f" } }] };
    assert.notEqual(cache.cacheKey(base), cache.cacheKey(withTools));
  });
});

describe("responseCache: cacheability policy", () => {
  test("deterministic requests are cacheable", () => {
    assert.equal(cache.isCacheable({ messages: [] }), true);
    assert.equal(cache.isCacheable({ messages: [], temperature: 0 }), true);
  });
  test("non-zero temperature is NOT cacheable (caller wants variation)", () => {
    assert.equal(cache.isCacheable({ messages: [], temperature: 0.7 }), false);
    assert.equal(cache.isCacheable({ messages: [], temperature: 1 }), false);
  });
});

describe("responseCache: storage behavior", () => {
  test("miss then hit", () => {
    assert.equal(cache.get("k"), null);
    cache.set("k", { answer: 42 });
    assert.deepEqual(cache.get("k"), { answer: 42 });
  });

  test("entries expire after TTL", async () => {
    cache.set("k", { v: 1 }, 40);
    assert.ok(cache.get("k"));
    await new Promise((r) => setTimeout(r, 70));
    assert.equal(cache.get("k"), null);
  });

  test("evicts least-recently-used at capacity", () => {
    for (let i = 0; i < 505; i++) cache.set("k" + i, { i });
    assert.equal(cache.stats().entries, 500);
    assert.equal(cache.get("k0"), null, "oldest evicted");
    assert.ok(cache.get("k504"), "newest retained");
  });

  test("a hit refreshes recency", () => {
    for (let i = 0; i < 500; i++) cache.set("k" + i, { i });
    cache.get("k0");           // touch the oldest
    cache.set("overflow", {}); // force one eviction
    assert.ok(cache.get("k0"), "touched entry survived");
  });

  test("tracks hit rate", () => {
    cache.set("k", {});
    cache.get("k");
    cache.get("missing");
    const s = cache.stats();
    assert.equal(s.hits, 1);
    assert.equal(s.misses, 1);
    assert.equal(s.hitRatePct, 50);
  });
});

// The cache key and the adapters read one shared list of sampling parameters.
// If they ever drift, the symptom is a caller asking for JSON and being handed
// a cached prose answer to the same question.
describe("responseCache: sampling parameters are part of the key", () => {
  const base = { model: "m", messages: [{ role: "user", content: "hi" }] };
  const key = (extra) => cache.cacheKey({ ...base, ...extra }, "caller");

  test("a request asking for JSON never collides with the plain one", () => {
    assert.notEqual(key({}), key({ response_format: { type: "json_object" } }));
    assert.notEqual(
      key({ response_format: { type: "json_object" } }),
      key({ response_format: { type: "json_schema", json_schema: { schema: {} } } })
    );
  });

  test("every carried parameter changes the key", () => {
    const cases = [
      ["top_p", 0.5], ["stop", ["x"]], ["seed", 7],
      ["frequency_penalty", 0.5], ["presence_penalty", 0.5], ["logit_bias", { 1: 1 }]
    ];
    for (const [param, value] of cases) {
      assert.notEqual(key({}), key({ [param]: value }), `${param} must change the key`);
    }
  });

  test("not sending a parameter is not a difference", () => {
    // Otherwise every plain request would miss against every other plain one.
    assert.equal(key({}), key({ seed: undefined, stop: null }));
  });

  test("the key list is the list the adapters forward", async () => {
    const { SAMPLING_PARAMS } = await import("../src/routing/sampling.js");
    for (const param of SAMPLING_PARAMS) {
      const value = param === "response_format" ? { type: "json_object" } : "v";
      assert.notEqual(key({}), key({ [param]: value }),
        `${param} is forwarded to providers but absent from the cache key`);
    }
  });
});

describe("responseCache: the hit rate does not overstate its inputs", () => {
  test("no lookups reads as no measurement, not as 0%", () => {
    const s = cache.stats();
    assert.equal(s.hits, 0);
    assert.equal(s.misses, 0);
    // "0% of lookups hit" describes a cache that is failing. Nothing has been
    // asked of it. Callers render null as the no-reading glyph.
    assert.equal(s.hitRatePct, null);
  });

  test("a real miss is a real reading of 0%", () => {
    cache.get("nothing-is-stored-under-this-key");
    assert.equal(cache.stats().hitRatePct, 0);
  });

  test("a hit moves it off zero", () => {
    const key = cache.cacheKey({ model: "m", messages: [] }, "caller");
    cache.set(key, { provider: "p", choices: [] });
    cache.get(key);
    assert.ok(cache.stats().hitRatePct > 0);
  });
});
