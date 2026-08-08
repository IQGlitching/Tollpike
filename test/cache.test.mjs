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
