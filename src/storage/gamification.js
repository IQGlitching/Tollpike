// Streaks, achievements and live savings.
//
// This is a presentation layer over data the gateway already records. It stores
// nothing of its own and invents no numbers: every figure here is derived from
// usage.jsonl, the quota counters and the provider price table, so it cannot
// disagree with the ledger.
//
// SAVINGS ARE A COUNTERFACTUAL, and that word does a lot of work. "You saved
// $40" is only meaningful against a stated alternative, and most dashboards
// that show a savings figure never say what they compared against — which
// makes the number unfalsifiable and therefore worthless. The baseline here is
// explicit and reported alongside the figure:
//
//   baseline = the same tokens, priced at the most expensive VERIFIED-price
//              lane that lists a model and could have served the request
//
// Verified-price only, because a baseline built on an unchecked price table
// produces a savings figure with an unchecked price table's error bars, and the
// error is unbounded in the flattering direction. If no verified lane exists,
// savings are reported as unavailable rather than computed against a guess.

import { getUsageSummary, getUsageSeries, TOKENS_PER_PRICE_UNIT } from "./costTracker.js";
import { providers, priceFor, isPricingVerified } from "../providers/registry.js";
import { quotaSnapshot } from "./quotaTracker.js";

const OUTPUT_WEIGHT = 3; // same in:out assumption as the cheapest strategy

// Most expensive verified lane, used as the "if you had not routed" reference.
function baselineLane() {
  const candidates = providers
    .filter((p) => p.category !== "local" && p.models.length > 0 && isPricingVerified(p))
    .map((p) => {
      const model = p.models.reduce((worst, m) => {
        const price = priceFor(p, m);
        const worstPrice = priceFor(p, worst);
        return (price.input || 0) + (price.output || 0) * OUTPUT_WEIGHT >
          (worstPrice.input || 0) + (worstPrice.output || 0) * OUTPUT_WEIGHT
          ? m
          : worst;
      }, p.models[0]);
      const price = priceFor(p, model);
      return { provider: p.id, model, price, blended: (price.input || 0) + (price.output || 0) * OUTPUT_WEIGHT };
    })
    .sort((a, b) => b.blended - a.blended);

  return candidates[0] || null;
}

export function savings() {
  const usage = getUsageSummary();
  const baseline = baselineLane();

  if (!baseline) {
    return {
      available: false,
      reason:
        "No provider with verified pricing, so there is no trustworthy baseline to compare against. " +
        "Run npm run verify-pricing and set real rates first."
    };
  }

  // Tokens are counted, not split in:out, because usage.jsonl aggregates them.
  // Applying the blended rate to the total is therefore an approximation, and a
  // mildly conservative one at the 1:3 assumption used everywhere else.
  // /(1 + OUTPUT_WEIGHT), not /4. `blended` is one input part plus
  // OUTPUT_WEIGHT output parts, so averaging it back to a per-token rate
  // divides by the number of parts. Written as a literal 4 it silently
  // depended on OUTPUT_WEIGHT still being 3: changing the weight to 4 left
  // the divisor behind and overstated the baseline, and therefore the
  // reported savings, by 25%.
  const blendedPerToken = baseline.blended / (1 + OUTPUT_WEIGHT) / TOKENS_PER_PRICE_UNIT;
  const baselineCost = usage.totalTokens * blendedPerToken;
  const actualCost = usage.totalCostUsd;
  const savedUsd = Math.max(0, baselineCost - actualCost);

  const quota = quotaSnapshot();
  const freeTokens = quota.totals.freeTokensToday;

  return {
    available: true,
    actualCostUsd: Number(actualCost.toFixed(8)),
    baselineCostUsd: Number(baselineCost.toFixed(8)),
    savedUsd: Number(savedUsd.toFixed(8)),
    savedPct: baselineCost > 0 ? Math.round((savedUsd / baselineCost) * 100) : 0,
    tokens: usage.totalTokens,
    freeTokensToday: freeTokens,
    freeValueTodayUsd: Number((freeTokens * blendedPerToken).toFixed(8)),
    baseline: {
      provider: baseline.provider,
      model: baseline.model,
      costPer1mTokens: baseline.price,
      description: `every token priced at ${baseline.provider}/${baseline.model}, the most expensive lane with verified pricing`
    },
    // Repeated at the point of consumption. Someone reading a savings figure off
    // a dashboard will not have read the module comment.
    // reportedPct is null until something has actually been measured, and
    // interpolating that straight into prose produced "null% of recorded
    // spend". Say what is true instead: there is nothing to qualify yet.
    caveat:
      "A counterfactual against the stated baseline, not money that was in an account. " +
      (usage.confidence.reportedPct === null
        ? "No spend has been recorded yet, so there is nothing to qualify."
        : `Accuracy also depends on token accounting: ${usage.confidence.reportedPct}% of recorded spend ` +
          "is backed by the provider's own usage numbers, the rest is estimated.")
  };
}

export function streak() {
  // 90 days is the window; a streak longer than that reports as 90+ rather
  // than being silently truncated to a smaller-looking number.
  const series = getUsageSeries({ bucket: "day", points: 90 });
  const active = series.map((point) => point.requests > 0);

  let current = 0;
  for (let i = active.length - 1; i >= 0; i--) {
    // Today counts if it has traffic; if it does not, the streak is measured to
    // yesterday rather than being reported as broken at 00:00. A streak that
    // resets every midnight until you make a request is a discouraging lie.
    if (!active[i]) {
      if (i === active.length - 1) continue;
      break;
    }
    current++;
  }

  let longest = 0;
  let run = 0;
  for (const day of active) {
    run = day ? run + 1 : 0;
    longest = Math.max(longest, run);
  }

  const activeDays = active.filter(Boolean).length;
  return {
    currentDays: current,
    longestDays: longest,
    activeDaysInWindow: activeDays,
    windowDays: series.length,
    truncated: current >= series.length,
    todayActive: active[active.length - 1] === true
  };
}

// Achievements are predicates over observable state. Each carries the metric it
// reads so the panel can show progress rather than a locked padlock with no
// hint of what it wants.
const ACHIEVEMENTS = [
  {
    id: "first-route",
    label: "First route",
    description: "Route one request through the gateway.",
    target: 1,
    progress: (s) => s.usage.totalRequests
  },
  {
    id: "hundred-routes",
    label: "Century",
    description: "Route 100 requests.",
    target: 100,
    progress: (s) => s.usage.totalRequests
  },
  {
    id: "ten-thousand-routes",
    label: "Five nines of nothing",
    description: "Route 10,000 requests.",
    target: 10_000,
    progress: (s) => s.usage.totalRequests
  },
  {
    id: "million-tokens",
    label: "Megatoken",
    description: "Move a million tokens.",
    target: 1_000_000,
    progress: (s) => s.usage.totalTokens
  },
  {
    id: "multi-lane",
    label: "Multi-lane",
    description: "Get a successful response from 5 different providers.",
    target: 5,
    progress: (s) => Object.values(s.usage.byProvider).filter((p) => p.requests > 0).length
  },
  {
    id: "free-rider",
    label: "Free rider",
    description: "Serve 10,000 tokens from free-tier quota in a day.",
    target: 10_000,
    progress: (s) => s.quota.totals.freeTokensToday
  },
  {
    id: "week-streak",
    label: "Seven day streak",
    description: "Use the gateway on 7 consecutive days.",
    target: 7,
    progress: (s) => s.streak.currentDays
  },
  {
    id: "month-streak",
    label: "Thirty day streak",
    description: "Use the gateway on 30 consecutive days.",
    target: 30,
    progress: (s) => s.streak.currentDays
  },
  {
    id: "trustworthy-spend",
    label: "Trustworthy spend",
    description: "Have 90% of recorded spend backed by provider-reported usage rather than estimates.",
    target: 90,
    progress: (s) => s.usage.confidence.reportedPct
  },
  {
    id: "capped",
    label: "Capped",
    description: "Set a monthly budget cap on a provider with verified pricing.",
    target: 1,
    progress: (s) =>
      Object.keys(s.settings.budgetCapsUsd || {}).filter((id) => {
        const provider = providers.find((p) => p.id === id);
        return provider && isPricingVerified(provider);
      }).length
  },
  {
    id: "combo-builder",
    label: "Combo builder",
    description: "Save a custom routing combo.",
    target: 1,
    progress: (s) => Object.keys(s.settings.combos || {}).length
  },
  {
    id: "compressed",
    label: "Squeezed",
    description: "Turn on RTK and Caveman together.",
    target: 2,
    progress: (s) =>
      (s.settings.compression?.rtk?.enabled ? 1 : 0) +
      (s.settings.compression?.caveman?.enabled && s.settings.compression.caveman.level !== "off" ? 1 : 0)
  },
  {
    id: "remembers",
    label: "Remembers",
    description: "Store 100 memories.",
    target: 100,
    progress: (s) => s.memoryTotal
  },
  {
    id: "no-single-point",
    label: "No single point",
    description: "Configure keys for 3 or more providers.",
    target: 3,
    progress: () => providers.filter((p) => p.available && p.category !== "local").length
  }
];

export function achievements(context) {
  return ACHIEVEMENTS.map((achievement) => {
    const progress = Math.max(0, achievement.progress(context) || 0);
    return {
      id: achievement.id,
      label: achievement.label,
      description: achievement.description,
      target: achievement.target,
      progress: Math.min(progress, achievement.target),
      rawProgress: progress,
      unlocked: progress >= achievement.target,
      pct: Math.min(100, Math.round((progress / achievement.target) * 100))
    };
  });
}

/**
 * Everything the panel's Achievements page needs, in one call.
 *
 * `settings` and `memoryTotal` are passed in rather than imported so this
 * module stays free of a dependency on the memory subsystem — gamification
 * being able to break recall would be an absurd coupling.
 */
export function gamificationSnapshot({ settings, memoryTotal = 0 } = {}) {
  const context = {
    usage: getUsageSummary(),
    quota: quotaSnapshot(),
    streak: streak(),
    settings: settings || {},
    memoryTotal
  };

  const unlocked = achievements(context);
  return {
    streak: context.streak,
    savings: savings(),
    achievements: unlocked,
    totals: {
      unlocked: unlocked.filter((a) => a.unlocked).length,
      total: unlocked.length
    }
  };
}

export const ACHIEVEMENT_IDS = ACHIEVEMENTS.map((a) => a.id);
