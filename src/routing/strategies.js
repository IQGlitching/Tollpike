// Routing strategies and tiered combos.
//
// A strategy is a pure ordering function: given the candidate pool and a
// context object, return the pool ordered best-first. It does not decide
// whether a provider is usable — that stays in router.skipReason(), which
// runs per candidate at call time and knows about circuit breakers, cooling
// keys and budget caps. Keeping the two apart is what makes `attempts[]`
// explainable: the strategy says why a provider was *preferred*, skipReason
// says why it was *passed over*.
//
// Every strategy is a total order over the whole pool, never a filter. A
// strategy that returned only its favourites would silently shrink the
// fallback chain, so "cheapest" means the cheapest first and the most
// expensive last — not "only the cheap ones". Filtering is a tier's job, and
// a tier that filters everything out is caught at validation time.
//
// A combo is up to N tiers, each { strategy, filter }, evaluated in order and
// concatenated with duplicates removed. Tier 1 is where you want traffic,
// tier 2 is what you accept when tier 1 is out, tier 3 is what you accept
// rather than fail. The classic:
//
//   tier 1  drain-free       burn the allowance you already have
//   tier 2  cheapest         then pay as little as possible
//   tier 3  priority         then just answer the request
//
// Ordering data comes from real observation — the usage log, the resilience
// maps, the quota counters — so an unmeasured provider is never treated as
// fast, cheap or healthy. Unknown sorts last in every strategy here. That
// asymmetry is deliberate: optimism about an unmeasured lane makes routing
// flap, and flapping is indistinguishable from a broken gateway.

import { priceFor, contextWindowFor, billingOf, isPricingVerified } from "../providers/registry.js";
import { getUsageSummary, getMonthlySpend } from "../storage/costTracker.js";
import { quotaStatus, isFreeTier } from "../storage/quotaTracker.js";
import * as resilience from "./resilience.js";
import { estimateTokens, promptTextOf } from "../providers/normalize.js";

// Rotating cursors, one per strategy that needs to remember where it was.
const cursors = { roundrobin: 0, spread: 0 };

// Last provider that answered successfully, for session affinity.
let lastSuccessful = null;

export function recordStrategyOutcome(providerId, ok) {
  if (ok) lastSuccessful = providerId;
}

// Blended price. Output tokens cost 2-5x input at most vendors, so ordering
// on input price alone ranks a cheap-in/expensive-out model above a flat one
// that is actually cheaper for real traffic. The 1:3 in:out assumption is
// the observed shape of chat traffic; it is a constant here rather than a
// setting because nobody can tune a number they cannot see the effect of.
const OUTPUT_WEIGHT = 3;

function blendedPrice(provider, model) {
  const price = priceFor(provider, model);
  return (price.input || 0) + (price.output || 0) * OUTPUT_WEIGHT;
}

function firstModel(provider) {
  return provider.models[0];
}

// Recent failure rate from the resilience maps. A provider whose breaker is
// open is not merely unhealthy, it is unusable — skipReason will drop it —
// but ordering still wants to know, because a provider that has been tripping
// intermittently should not be tier 1.
function healthScore(providerId) {
  const snap = resilience.snapshot();
  const provider = snap.providers[providerId];
  if (!provider) return 1;
  if (provider.status === "OPEN") return 0;
  const failures = provider.failures || 0;
  return 1 / (1 + failures);
}

function latencyOf(usage, providerId) {
  const measured = usage.byProvider[providerId]?.avgLatencyMs;
  return measured > 0 ? measured : Infinity; // unmeasured sorts last, never first
}

function requestsOf(usage, providerId) {
  return usage.byProvider[providerId]?.requests || 0;
}

// Deterministic-per-process shuffle seed. Math.random() is fine for the
// randomized strategy — the goal is that a provider cannot predict which
// backend it is talking to, not cryptographic unpredictability.
function shuffle(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function rotate(list, key) {
  if (list.length === 0) return list;
  cursors[key] = (cursors[key] + 1) % list.length;
  return [...list.slice(cursors[key]), ...list.slice(0, cursors[key])];
}

// Stable tiebreak, used as the final comparator everywhere. Without it,
// two providers with equal scores can swap order between calls and make
// routing look nondeterministic for no reason.
const byPriority = (a, b) => a.priority - b.priority || a.id.localeCompare(b.id);

function sortBy(pool, score) {
  return [...pool].sort((a, b) => {
    const diff = score(a) - score(b);
    return diff !== 0 ? diff : byPriority(a, b);
  });
}

export const STRATEGIES = {
  priority: {
    label: "Priority",
    description: "Config order. What you set in providers.json, respected exactly.",
    order: (pool) => [...pool].sort(byPriority)
  },

  cheapest: {
    label: "Cheapest first",
    description: "Lowest blended cost-per-token that can serve the request.",
    order: (pool) => sortBy(pool, (p) => blendedPrice(p, firstModel(p)))
  },

  "cheapest-input": {
    label: "Cheapest input",
    description: "Lowest input price. For prompt-heavy, short-answer traffic.",
    order: (pool) => sortBy(pool, (p) => priceFor(p, firstModel(p)).input || 0)
  },

  fastest: {
    label: "Fastest",
    description: "Lowest measured average latency. Unmeasured lanes sort last.",
    order: (pool, ctx) => sortBy(pool, (p) => latencyOf(ctx.usage, p.id))
  },

  roundrobin: {
    label: "Round robin",
    description: "Rotates the starting point every call. Even distribution.",
    order: (pool) => rotate([...pool].sort(byPriority), "roundrobin")
  },

  randomized: {
    label: "Randomized",
    description:
      "Unpredictable pick, so a single backend cannot be fingerprinted from traffic shape.",
    order: (pool) => shuffle(pool)
  },

  "spread-load": {
    label: "Spread load",
    description:
      "Fewest requests sent so far first. Balances across keys and accounts to stay under per-key limits.",
    order: (pool, ctx) => sortBy(pool, (p) => requestsOf(ctx.usage, p.id) / Math.max(1, p.connections.length))
  },

  "drain-free": {
    label: "Drain free quota",
    description:
      "Free allowances first, most headroom first. Exhausted pools sort behind paid lanes.",
    order: (pool, ctx) =>
      sortBy(pool, (p) => {
        if (!isFreeTier(p)) return 1; // paid lanes after every free one with quota
        const status = ctx.quota[p.id];
        if (!status || status.exhausted) return 2; // exhausted free lane is worse than a paid one
        return -status.headroom; // most headroom first
      })
  },

  "drain-subscription": {
    label: "Drain subscription",
    description:
      "Burn the quota you already paid for — subscription-covered and local lanes before anything metered.",
    order: (pool, ctx) =>
      sortBy(pool, (p) => {
        const billing = billingOf(p, ctx.subscriptionProviders);
        return { subscription: 0, local: 1, "free-tier": 2, metered: 3 }[billing] ?? 3;
      })
  },

  "quota-headroom": {
    label: "Quota headroom",
    description: "Most remaining free quota first, counted per shared pool rather than per provider.",
    order: (pool, ctx) =>
      sortBy(pool, (p) => {
        const status = ctx.quota[p.id];
        return status ? -status.headroom : 0;
      })
  },

  "budget-headroom": {
    label: "Budget headroom",
    description: "Most remaining monthly budget first. Spreads spend instead of exhausting one cap.",
    order: (pool, ctx) =>
      sortBy(pool, (p) => {
        const cap = ctx.budgetCapsUsd[p.id];
        if (cap === undefined || cap === null) return -Infinity; // uncapped has unlimited headroom
        return -(cap - getMonthlySpend(p.id));
      })
  },

  "context-aware": {
    label: "Context aware",
    description:
      "Keeps long contexts on models that can hold them. Smallest sufficient window first; too-small lanes last.",
    order: (pool, ctx) =>
      sortBy(pool, (p) => {
        const window = contextWindowFor(p, firstModel(p));
        if (window === null) return 1e12; // undeclared: after every known fit, before known misfits
        // Cannot hold the prompt, so it is a last resort — but among last
        // resorts the LARGEST window is the best one: it truncates least, and
        // promptTokens is an estimate that may be a little pessimistic.
        // Subtracting keeps that ordering while staying above the unknown bucket.
        if (window < ctx.promptTokens) return 1e15 - window;
        return window; // fits: prefer the smallest that does, leaving big windows for big jobs
      })
  },

  "least-errors": {
    label: "Least errors",
    description: "Healthiest lanes first, by observed failure count and breaker state.",
    order: (pool) => sortBy(pool, (p) => -healthScore(p.id))
  },

  balanced: {
    label: "Balanced cost/latency",
    description: "Normalized cost x latency. The default when you want neither extreme.",
    order: (pool, ctx) => {
      const prices = pool.map((p) => blendedPrice(p, firstModel(p)));
      const latencies = pool.map((p) => latencyOf(ctx.usage, p.id)).filter((n) => n !== Infinity);
      const maxPrice = Math.max(...prices, 1);
      const maxLatency = Math.max(...latencies, 1);
      return sortBy(pool, (p) => {
        const price = blendedPrice(p, firstModel(p)) / maxPrice;
        const latency = latencyOf(ctx.usage, p.id);
        // An unmeasured lane scores as median rather than worst here: this
        // strategy is explicitly a compromise, and never trying a new
        // provider means never measuring it.
        const normLatency = latency === Infinity ? 0.5 : latency / maxLatency;
        return price + normLatency;
      });
    }
  },

  "verified-pricing": {
    label: "Verified pricing first",
    description:
      "Lanes whose price table was actually checked. Spend you can reconcile against an invoice.",
    order: (pool) => sortBy(pool, (p) => (isPricingVerified(p) ? 0 : 1))
  },

  "local-first": {
    label: "Local first",
    description: "Local runtimes before anything that leaves the machine. Zero cost, no egress.",
    order: (pool) => sortBy(pool, (p) => (p.category === "local" ? 0 : 1))
  },

  "frontier-first": {
    label: "Frontier first",
    description: "Frontier labs first, then inference hosts, then aggregators, then local.",
    order: (pool) =>
      sortBy(pool, (p) => ({ frontier: 0, inference: 1, aggregator: 2, local: 3 }[p.category] ?? 2))
  },

  sticky: {
    label: "Sticky",
    description:
      "Pins to the last provider that answered. Keeps a conversation on one model and warms its cache.",
    order: (pool) => {
      const sorted = [...pool].sort(byPriority);
      if (!lastSuccessful) return sorted;
      const pinned = sorted.filter((p) => p.id === lastSuccessful);
      return [...pinned, ...sorted.filter((p) => p.id !== lastSuccessful)];
    }
  },

  "cost-ceiling": {
    label: "Cost ceiling",
    description:
      "Anything at or below the tier's maxCostPer1m first, cheapest of the rest after. Pair with a filter.",
    order: (pool, ctx) =>
      sortBy(pool, (p) => {
        const price = blendedPrice(p, firstModel(p));
        const ceiling = ctx.maxCostPer1m ?? Infinity;
        return price <= ceiling ? price : 1e9 + price;
      })
  }
};

export const STRATEGY_IDS = Object.keys(STRATEGIES);

// Back-compatible aliases. `auto/cheap` was the documented spelling before
// this file existed and appears in the README, the panel and probably in
// someone's client config, so it keeps working.
export const STRATEGY_ALIASES = {
  cheap: "cheapest",
  cost: "cheapest",
  speed: "fastest",
  latency: "fastest",
  random: "randomized",
  rr: "roundrobin",
  free: "drain-free",
  subscription: "drain-subscription",
  quota: "quota-headroom",
  context: "context-aware",
  health: "least-errors",
  auto: "priority"
};

export function resolveStrategy(name) {
  if (!name) return "priority";
  const key = String(name).toLowerCase();
  return STRATEGIES[key] ? key : STRATEGY_ALIASES[key] || null;
}

// ---- Tier filters -----------------------------------------------------------

// A filter narrows which providers a tier considers. Unlike a strategy it
// really does remove candidates — that is the point of a tier.
export function applyFilter(pool, filter = {}, ctx) {
  let out = pool;
  if (filter.providers?.length) out = out.filter((p) => filter.providers.includes(p.id));
  if (filter.exclude?.length) out = out.filter((p) => !filter.exclude.includes(p.id));
  if (filter.categories?.length) out = out.filter((p) => filter.categories.includes(p.category));
  if (filter.billing?.length) {
    out = out.filter((p) => filter.billing.includes(billingOf(p, ctx.subscriptionProviders)));
  }
  if (filter.freeOnly) out = out.filter((p) => isFreeTier(p));
  if (filter.verifiedPricingOnly) out = out.filter((p) => isPricingVerified(p));
  if (filter.maxCostPer1m !== undefined && filter.maxCostPer1m !== null) {
    out = out.filter((p) => blendedPrice(p, firstModel(p)) <= filter.maxCostPer1m);
  }
  if (filter.minContextWindow !== undefined && filter.minContextWindow !== null) {
    // An undeclared window cannot be asserted to satisfy a minimum. Excluding
    // it here is the same call as sorting it late in context-aware.
    out = out.filter((p) => (contextWindowFor(p, firstModel(p)) ?? 0) >= filter.minContextWindow);
  }
  if (filter.withQuotaRemaining) {
    out = out.filter((p) => {
      const status = ctx.quota[p.id];
      return status ? !status.exhausted : false;
    });
  }
  return out;
}

export const FILTER_KEYS = [
  "providers",
  "exclude",
  "categories",
  "billing",
  "freeOnly",
  "verifiedPricingOnly",
  "maxCostPer1m",
  "minContextWindow",
  "withQuotaRemaining"
];

// ---- Combos -----------------------------------------------------------------

export const MAX_TIERS = 4;

// Shipped combos. These are the ones worth having by default; a custom combo
// with the same name overrides the built-in, so nothing here is a reserved
// word the operator cannot use.
export const BUILTIN_COMBOS = {
  "free-first": {
    label: "Free first",
    description: "Drain every free allowance, then the cheapest paid lane, then anything that answers.",
    tiers: [
      { strategy: "drain-free", filter: { freeOnly: true, withQuotaRemaining: true } },
      { strategy: "cheapest" },
      { strategy: "priority" }
    ]
  },
  "paid-for-it": {
    label: "Paid for it",
    description: "Subscription and local lanes first, free tiers next, metered last.",
    tiers: [
      { strategy: "drain-subscription", filter: { billing: ["subscription", "local"] } },
      { strategy: "drain-free", filter: { freeOnly: true, withQuotaRemaining: true } },
      { strategy: "cheapest" }
    ]
  },
  "cost-floor": {
    label: "Cost floor",
    description: "Cheapest verified-price lane first, so the number on the invoice is predictable.",
    tiers: [
      { strategy: "cheapest", filter: { verifiedPricingOnly: true } },
      { strategy: "cheapest" },
      { strategy: "priority" }
    ]
  },
  "quality-first": {
    label: "Quality first",
    description: "Frontier labs, then fast inference hosts, then whatever is left.",
    tiers: [
      { strategy: "priority", filter: { categories: ["frontier"] } },
      { strategy: "fastest", filter: { categories: ["inference"] } },
      { strategy: "priority" }
    ]
  },
  "long-context": {
    label: "Long context",
    description: "Only lanes that can hold the prompt, smallest sufficient window first.",
    tiers: [
      { strategy: "context-aware", filter: { minContextWindow: 200_000 } },
      { strategy: "context-aware" },
      { strategy: "priority" }
    ]
  },
  resilient: {
    label: "Resilient",
    description: "Healthiest lanes first, spread load next, anything at all last.",
    tiers: [
      { strategy: "least-errors" },
      { strategy: "spread-load" },
      { strategy: "priority" }
    ]
  },
  stealth: {
    label: "Stealth",
    description: "Randomized then spread, so no single backend sees a recognisable traffic pattern.",
    tiers: [{ strategy: "randomized" }, { strategy: "spread-load" }]
  },
  private: {
    label: "Private",
    description: "Local runtimes only. Nothing leaves the machine; fails rather than falling back.",
    tiers: [{ strategy: "local-first", filter: { categories: ["local"] } }]
  }
};

export function validateCombo(combo) {
  if (!combo || typeof combo !== "object") return { ok: false, error: "combo must be an object" };
  if (!Array.isArray(combo.tiers) || combo.tiers.length === 0) {
    return { ok: false, error: "combo.tiers must be a non-empty array" };
  }
  if (combo.tiers.length > MAX_TIERS) {
    return { ok: false, error: `a combo may have at most ${MAX_TIERS} tiers` };
  }

  const tiers = [];
  for (const [index, tier] of combo.tiers.entries()) {
    if (!tier || typeof tier !== "object") {
      return { ok: false, error: `tier ${index + 1} must be an object` };
    }
    const strategy = resolveStrategy(tier.strategy);
    if (!strategy) {
      return {
        ok: false,
        error: `tier ${index + 1}: unknown strategy "${tier.strategy}". Known: ${STRATEGY_IDS.join(", ")}`
      };
    }
    const filter = {};
    for (const [key, value] of Object.entries(tier.filter || {})) {
      if (!FILTER_KEYS.includes(key)) {
        return { ok: false, error: `tier ${index + 1}: unknown filter "${key}". Known: ${FILTER_KEYS.join(", ")}` };
      }
      filter[key] = value;
    }
    if (filter.maxCostPer1m !== undefined && filter.maxCostPer1m !== null) {
      const n = Number(filter.maxCostPer1m);
      if (!Number.isFinite(n) || n < 0) {
        return { ok: false, error: `tier ${index + 1}: maxCostPer1m must be a non-negative number` };
      }
      filter.maxCostPer1m = n;
    }
    if (filter.minContextWindow !== undefined && filter.minContextWindow !== null) {
      const n = Number(filter.minContextWindow);
      if (!Number.isInteger(n) || n < 0) {
        return { ok: false, error: `tier ${index + 1}: minContextWindow must be a non-negative integer` };
      }
      filter.minContextWindow = n;
    }
    tiers.push({ strategy, filter });
  }

  return {
    ok: true,
    value: {
      label: typeof combo.label === "string" ? combo.label.slice(0, 80) : undefined,
      description: typeof combo.description === "string" ? combo.description.slice(0, 240) : undefined,
      tiers
    }
  };
}

// Names that mean something to JavaScript objects rather than to routing.
// `__proto__` assigned onto an ordinary object literal replaces its prototype
// instead of adding a member, and `constructor`/`prototype` shadow properties
// every object already has.
const UNSAFE_COMBO_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export function comboName(name) {
  const slug = String(name || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40);
  // Returning "" makes this fail the caller's existing "must contain a-z, 0-9
  // or -" check, which is the right error: these are not usable combo names.
  // Note the character filter alone does NOT catch these — "constructor" is
  // already lowercase a-z and passes through it untouched.
  return UNSAFE_COMBO_NAMES.has(slug) ? "" : slug;
}

export function listCombos(savedCombos = {}) {
  // Null-prototype base, and unsafe names skipped on the way in.
  //
  // comboName() gates the endpoints that create combos, but it is not the only
  // way in: `combos` is in the MCP settings_patch allowlist, so a whole combos
  // object can be written without passing through it — and settings.json can be
  // edited directly. On a plain object literal, `merged["__proto__"] = x` sets
  // the prototype rather than adding a key, which made every unknown combo name
  // resolvable through the attacker's object: `combo/anything` would find tiers
  // that were never saved. Contained to this object (global Object.prototype
  // was never reachable), but it is still routing the operator did not choose.
  const merged = Object.assign(Object.create(null), BUILTIN_COMBOS);
  for (const [name, combo] of Object.entries(savedCombos)) {
    if (UNSAFE_COMBO_NAMES.has(name)) continue;
    merged[name] = { ...combo, custom: true };
  }
  return merged;
}

// ---- Ordering ---------------------------------------------------------------

/**
 * Build the context every strategy reads from. Gathered once per request:
 * quotaStatus and getUsageSummary both do real work, and a strategy that
 * called them per comparison would turn an O(n log n) sort into O(n log n)
 * file reads — the exact mistake getMonthlySpend already made once.
 */
export function strategyContext({ request, settings, pool }) {
  const quota = {};
  for (const provider of pool) {
    if (isFreeTier(provider)) quota[provider.id] = quotaStatus(provider.id);
  }
  return {
    request,
    usage: getUsageSummary(),
    quota,
    budgetCapsUsd: settings.budgetCapsUsd || {},
    subscriptionProviders: settings.subscriptionProviders || [],
    promptTokens: request ? estimateTokens(promptTextOf(request)) : 0,
    maxCostPer1m: null
  };
}

/**
 * Order a pool by one strategy. Exported so the panel can show what a
 * strategy would do without sending a request — a routing decision nobody
 * can preview is a routing decision nobody will trust.
 */
export function orderByStrategy(name, pool, ctx) {
  const key = resolveStrategy(name);
  if (!key) throw Object.assign(new Error(`Unknown routing strategy "${name}"`), { status: 400 });
  return STRATEGIES[key].order(pool, ctx);
}

/**
 * Flatten a combo into one ordered candidate chain.
 *
 * Tiers concatenate, and a provider already placed by an earlier tier is not
 * re-added: its first appearance is its best one, and a duplicate later in
 * the chain would make the same failing call twice.
 *
 * Providers matched by no tier are appended in priority order unless the
 * combo sets `strict`. Without that tail a filter typo silently becomes an
 * outage; with `strict` — which is what `private` uses — being unable to
 * serve the request is the correct outcome and falling back would violate
 * the promise the combo makes.
 */
export function orderByCombo(combo, pool, ctx) {
  const seen = new Set();
  const chain = [];

  for (const [index, tier] of combo.tiers.entries()) {
    const tierCtx = { ...ctx, maxCostPer1m: tier.filter?.maxCostPer1m ?? ctx.maxCostPer1m };
    const filtered = applyFilter(pool, tier.filter, tierCtx);
    for (const provider of orderByStrategy(tier.strategy, filtered, tierCtx)) {
      if (seen.has(provider.id)) continue;
      seen.add(provider.id);
      chain.push({ provider, tier: index + 1, strategy: tier.strategy });
    }
  }

  if (!combo.strict) {
    for (const provider of [...pool].sort(byPriority)) {
      if (seen.has(provider.id)) continue;
      seen.add(provider.id);
      chain.push({ provider, tier: combo.tiers.length + 1, strategy: "priority (tail)" });
    }
  }

  return chain;
}

// Test seam. Cursors and the sticky pin are process state, and a test that
// asserts rotation has to be able to start from a known point.
export function _resetStrategyState() {
  cursors.roundrobin = 0;
  cursors.spread = 0;
  lastSuccessful = null;
}
