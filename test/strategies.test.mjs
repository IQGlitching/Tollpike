import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tollpike-strategies-"));
process.env.TOLLPIKE_DATA_DIR = tmpDir;

let S;
let registry;
let settingsModule;

before(async () => {
  registry = await import("../src/providers/registry.js");
  settingsModule = await import("../src/storage/settings.js");
  S = await import("../src/routing/strategies.js");
});

beforeEach(() => S._resetStrategyState());

const poolOf = (ids) => ids.map((id) => registry.getProvider(id));

function ctxFor(pool, overrides = {}) {
  return {
    ...S.strategyContext({
      request: { messages: [{ role: "user", content: "hello" }] },
      settings: settingsModule.getSettings(),
      pool
    }),
    ...overrides
  };
}

describe("strategies: registry shape", () => {
  test("every strategy has a label, description and order function", () => {
    for (const id of S.STRATEGY_IDS) {
      const strategy = S.STRATEGIES[id];
      assert.equal(typeof strategy.label, "string", `${id} label`);
      assert.ok(strategy.description.length > 20, `${id} description too thin`);
      assert.equal(typeof strategy.order, "function", `${id} order`);
    }
  });

  test("every strategy is a total order, never a filter", () => {
    // A strategy that dropped candidates would silently shorten the fallback
    // chain: the request would fail with "all providers unavailable" while the
    // provider that could have served it was never attempted.
    const pool = registry.providers.filter((p) => p.models.length > 0);
    const ctx = ctxFor(pool);
    for (const id of S.STRATEGY_IDS) {
      const ordered = S.orderByStrategy(id, pool, ctx);
      assert.equal(ordered.length, pool.length, `${id} changed pool size`);
      assert.deepEqual(
        ordered.map((p) => p.id).sort(),
        pool.map((p) => p.id).sort(),
        `${id} changed pool membership`
      );
    }
  });

  test("resolves documented aliases", () => {
    assert.equal(S.resolveStrategy("cheap"), "cheapest");
    assert.equal(S.resolveStrategy("free"), "drain-free");
    assert.equal(S.resolveStrategy("CHEAP"), "cheapest");
    assert.equal(S.resolveStrategy("nonsense"), null);
  });

  test("rejects an unknown strategy with a 400", () => {
    assert.throws(() => S.orderByStrategy("nope", [], ctxFor([])), (err) => err.status === 400);
  });
});

describe("strategies: ordering", () => {
  test("cheapest orders on blended cost, not input alone", () => {
    // A lane with cheap input and expensive output is not cheap for real
    // traffic. anthropic 3/15 blends to 48; openai 2.5/10 blends to 32.
    const pool = poolOf(["anthropic", "openai"]);
    const ordered = S.orderByStrategy("cheapest", pool, ctxFor(pool));
    assert.equal(ordered[0].id, "openai");
  });

  test("fastest sorts unmeasured lanes last, never first", () => {
    // An unmeasured provider is not infinitely fast. Treating it as fast makes
    // routing flap between untried lanes on every request.
    const pool = poolOf(["groq", "anthropic"]);
    const ctx = ctxFor(pool, {
      usage: { byProvider: { anthropic: { avgLatencyMs: 900, requests: 5 } } }
    });
    assert.equal(S.orderByStrategy("fastest", pool, ctx)[0].id, "anthropic");
  });

  test("roundrobin advances the starting point each call", () => {
    const pool = poolOf(["anthropic", "openai", "gemini"]);
    const first = S.orderByStrategy("roundrobin", pool, ctxFor(pool))[0].id;
    const second = S.orderByStrategy("roundrobin", pool, ctxFor(pool))[0].id;
    assert.notEqual(first, second);
  });

  test("spread-load prefers the least-used lane, per connection", () => {
    const pool = poolOf(["groq", "openai"]);
    const ctx = ctxFor(pool, {
      usage: { byProvider: { groq: { requests: 100 }, openai: { requests: 2 } } }
    });
    assert.equal(S.orderByStrategy("spread-load", pool, ctx)[0].id, "openai");
  });

  test("drain-free puts a free lane with headroom ahead of a paid one", () => {
    const pool = poolOf(["anthropic", "groq"]);
    const ctx = ctxFor(pool);
    assert.equal(S.orderByStrategy("drain-free", pool, ctx)[0].id, "groq");
  });

  test("drain-free sorts an EXHAUSTED free lane behind a paid one", () => {
    // The whole point of tracking quota. A free lane with nothing left is
    // worse than a paid lane, because trying it costs a round-trip and a
    // guaranteed 429 before the fallback chain can advance.
    const pool = poolOf(["anthropic", "groq"]);
    const ctx = ctxFor(pool, {
      quota: { groq: { exhausted: true, headroom: 0 } }
    });
    assert.equal(S.orderByStrategy("drain-free", pool, ctx)[0].id, "anthropic");
  });

  test("drain-subscription puts operator-declared subscription lanes first", () => {
    const pool = poolOf(["anthropic", "ollama", "groq"]);
    const ctx = ctxFor(pool, { subscriptionProviders: ["anthropic"] });
    const ordered = S.orderByStrategy("drain-subscription", pool, ctx).map((p) => p.id);
    assert.deepEqual(ordered, ["anthropic", "ollama", "groq"]);
  });

  test("context-aware prefers the smallest window that fits", () => {
    // Leaves the big-context lanes free for jobs that need them instead of
    // burning a 1M-token model on a 200-token prompt.
    const pool = poolOf(["gemini", "groq", "ollama"]);
    const ctx = ctxFor(pool, { promptTokens: 50_000 });
    const ordered = S.orderByStrategy("context-aware", pool, ctx).map((p) => p.id);
    assert.equal(ordered[0], "groq"); // 128k fits, smallest that does
    assert.equal(ordered[1], "gemini"); // 1M fits but is oversized
    assert.equal(ordered[2], "ollama"); // 8k cannot hold it — last
  });

  test("context-aware puts too-small lanes last rather than dropping them", () => {
    const pool = poolOf(["ollama", "groq"]);
    const ctx = ctxFor(pool, { promptTokens: 900_000 });
    const ordered = S.orderByStrategy("context-aware", pool, ctx).map((p) => p.id);
    assert.equal(ordered.length, 2);
    assert.equal(ordered[1], "ollama"); // smaller window is the worse last resort
  });

  test("budget-headroom treats an uncapped lane as unlimited", () => {
    const pool = poolOf(["anthropic", "openai"]);
    const ctx = ctxFor(pool, { budgetCapsUsd: { anthropic: 0.01 } });
    assert.equal(S.orderByStrategy("budget-headroom", pool, ctx)[0].id, "openai");
  });

  test("local-first keeps remote lanes in the chain behind local ones", () => {
    const pool = poolOf(["anthropic", "ollama"]);
    const ordered = S.orderByStrategy("local-first", pool, ctxFor(pool)).map((p) => p.id);
    assert.deepEqual(ordered, ["ollama", "anthropic"]);
  });

  test("sticky pins the last successful provider to the front", () => {
    const pool = poolOf(["anthropic", "openai", "gemini"]);
    S.recordStrategyOutcome("gemini", true);
    assert.equal(S.orderByStrategy("sticky", pool, ctxFor(pool))[0].id, "gemini");
  });

  test("sticky is priority order before anything has succeeded", () => {
    const pool = poolOf(["openai", "anthropic"]);
    assert.equal(S.orderByStrategy("sticky", pool, ctxFor(pool))[0].id, "anthropic");
  });

  test("ordering is stable for equal scores", () => {
    // Without a deterministic tiebreak, two equal-scoring lanes swap places
    // between calls and routing looks broken for no reason.
    const pool = poolOf(["nvidia", "githubmodels", "huggingface"]);
    const ctx = ctxFor(pool);
    const a = S.orderByStrategy("verified-pricing", pool, ctx).map((p) => p.id);
    const b = S.orderByStrategy("verified-pricing", pool, ctx).map((p) => p.id);
    assert.deepEqual(a, b);
  });
});

describe("strategies: filters", () => {
  test("filters actually narrow the pool", () => {
    const pool = registry.providers.filter((p) => p.models.length > 0);
    const ctx = ctxFor(pool);
    const local = S.applyFilter(pool, { categories: ["local"] }, ctx);
    assert.ok(local.length > 0);
    assert.ok(local.every((p) => p.category === "local"));
  });

  test("minContextWindow excludes lanes with an undeclared window", () => {
    // An undeclared window cannot be asserted to satisfy a minimum, and
    // assuming it does is how a 300k prompt reaches a 32k model.
    const pool = poolOf(["groq"]);
    const original = pool[0].contextWindow;
    pool[0].contextWindow = undefined;
    try {
      assert.equal(S.applyFilter(pool, { minContextWindow: 1000 }, ctxFor(pool)).length, 0);
    } finally {
      pool[0].contextWindow = original;
    }
  });

  test("withQuotaRemaining drops exhausted and non-free lanes", () => {
    const pool = poolOf(["groq", "anthropic"]);
    const ctx = ctxFor(pool, { quota: { groq: { exhausted: false, headroom: 1 } } });
    const out = S.applyFilter(pool, { withQuotaRemaining: true }, ctx);
    assert.deepEqual(out.map((p) => p.id), ["groq"]);
  });
});

describe("combos", () => {
  test("every builtin combo validates", () => {
    for (const [name, combo] of Object.entries(S.BUILTIN_COMBOS)) {
      const parsed = S.validateCombo(combo);
      assert.equal(parsed.ok, true, `${name}: ${parsed.error}`);
    }
  });

  test("rejects an unknown strategy, filter key and oversized tier list", () => {
    assert.equal(S.validateCombo({ tiers: [{ strategy: "nope" }] }).ok, false);
    assert.equal(S.validateCombo({ tiers: [{ strategy: "cheapest", filter: { nope: 1 } }] }).ok, false);
    assert.equal(S.validateCombo({ tiers: [] }).ok, false);
    assert.equal(
      S.validateCombo({ tiers: Array.from({ length: S.MAX_TIERS + 1 }, () => ({ strategy: "priority" })) }).ok,
      false
    );
  });

  test("normalizes an alias inside a combo tier", () => {
    const parsed = S.validateCombo({ tiers: [{ strategy: "cheap" }] });
    assert.equal(parsed.value.tiers[0].strategy, "cheapest");
  });

  test("tiers concatenate and never repeat a provider", () => {
    const pool = registry.providers.filter((p) => p.models.length > 0);
    const chain = S.orderByCombo(S.BUILTIN_COMBOS["free-first"], pool, ctxFor(pool));
    const ids = chain.map((c) => c.provider.id);
    assert.equal(new Set(ids).size, ids.length, "a provider appeared twice in one chain");
  });

  test("a non-strict combo appends unmatched providers as a tail", () => {
    // Without the tail a filter typo becomes an outage rather than a
    // suboptimal route.
    const pool = registry.providers.filter((p) => p.models.length > 0);
    const chain = S.orderByCombo(
      { tiers: [{ strategy: "priority", filter: { providers: ["groq"] } }] },
      pool,
      ctxFor(pool)
    );
    assert.equal(chain.length, pool.length);
    assert.equal(chain[0].provider.id, "groq");
    assert.equal(chain[0].tier, 1);
    assert.equal(chain[1].tier, 2); // tail
    assert.match(chain[1].strategy, /tail/);
  });

  test("a strict combo refuses to fall back outside its tiers", () => {
    // `private` promises nothing leaves the machine. A tail would break that
    // promise in exactly the situation the operator chose it for.
    const pool = registry.providers.filter((p) => p.models.length > 0);
    const chain = S.orderByCombo({ ...S.BUILTIN_COMBOS.private, strict: true }, pool, ctxFor(pool));
    assert.ok(chain.length > 0);
    assert.ok(chain.every((c) => c.provider.category === "local"));
  });

  test("tags each candidate with the tier and strategy that placed it", () => {
    const pool = registry.providers.filter((p) => p.models.length > 0);
    const chain = S.orderByCombo(S.BUILTIN_COMBOS["quality-first"], pool, ctxFor(pool));
    assert.equal(chain[0].tier, 1);
    assert.equal(chain[0].strategy, "priority");
    assert.ok(chain.some((c) => c.tier === 2));
  });

  test("listCombos merges custom combos over builtins", () => {
    const merged = S.listCombos({ mine: { tiers: [{ strategy: "priority" }] } });
    assert.ok(merged["free-first"]);
    assert.equal(merged.mine.custom, true);
  });

  test("comboName sanitizes a name into a route-safe slug", () => {
    assert.equal(S.comboName("  My Combo!! "), "my-combo--");
    assert.equal(S.comboName("a".repeat(80)).length, 40);
  });
});
