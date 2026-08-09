// Free-quota accounting.
//
// The point of this file is *honest* counting, which is a stronger claim than
// counting. Three things make a naive free-tier counter lie:
//
//  1. SHARED POOLS. Several gateway entries can front the same upstream free
//     allowance. Hitting a model through OpenRouter's free tier and through
//     its vendor's own free tier may draw on two separate buckets — or one.
//     Counting per gateway-entry says you have 2× the quota you have. Every
//     free tier here declares a `quotaPool`; entries sharing a pool share a
//     counter. Where we do not know, the pool is the provider id, which
//     counts them separately and is the conservative direction only if the
//     pools really are separate — so `poolConfidence` records which it is
//     and the panel says so rather than implying certainty.
//
//  2. WINDOW SEMANTICS. "60 requests/minute" is a sliding window at the
//     vendor; a counter that resets on the wall-clock minute lets a caller
//     spend 120 in two seconds either side of the boundary. Requests use a
//     real sliding window. Daily limits use the vendor's own reset time
//     where it is known, because that is what actually resets.
//
//  3. FAILED REQUESTS STILL COUNT. A 500 from the provider consumed rate-limit
//     budget at almost every vendor. Only requests that never reached the
//     provider are free.
//
// What this does NOT do: read your remaining quota from the vendor. Almost
// none of them expose it. Every number here is what THIS gateway observed, so
// it undercounts whatever you spent through another client on the same key.
// `observedOnly: true` is on every reading for that reason.

import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../paths.js";
import { providers } from "../providers/registry.js";

const statePath = path.join(dataDir, "quota.json");

// Sliding-window event log, in memory. Persisted on a debounce so a restart
// doesn't hand back quota that was already spent.
//   pool -> { requests: [tsMs], tokens: [[tsMs, count]] }
const events = new Map();
let dirty = false;
let flushTimer = null;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

function ensureDir() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
}

function load() {
  ensureDir();
  if (!fs.existsSync(statePath)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    for (const [pool, entry] of Object.entries(raw.pools || {})) {
      events.set(pool, {
        requests: Array.isArray(entry.requests) ? entry.requests : [],
        tokens: Array.isArray(entry.tokens) ? entry.tokens : []
      });
    }
  } catch (err) {
    // A corrupt quota file must not brick routing. Starting from zero
    // over-reports remaining quota for one window, which fails toward
    // "attempt the request and let the vendor reject it" — the safe
    // direction, since the alternative is refusing to route at all.
    console.error(`[quota] unreadable quota.json (${err.message}); starting from empty`);
  }
}

function flush() {
  if (!dirty) return;
  dirty = false;
  try {
    ensureDir();
    const pools = {};
    for (const [pool, entry] of events.entries()) {
      pools[pool] = { requests: entry.requests, tokens: entry.tokens };
    }
    const tmp = `${statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ pools, savedAt: Date.now() }), { mode: 0o600 });
    fs.renameSync(tmp, statePath);
  } catch (err) {
    console.error(`[quota] could not persist quota state: ${err.message}`);
  }
}

function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  // unref so this timer never holds the process open — the e2e suite spawns
  // and kills the server, and a live handle turns that into a hang.
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, 2_000);
  if (typeof flushTimer.unref === "function") flushTimer.unref();
}

load();

// ---- Free-tier declarations -------------------------------------------------

// A provider declares its free tier in config/providers.json:
//   "freeTier": {
//     "pool": "groq-free",        // omit -> provider id, counted separately
//     "poolConfidence": "known",  // known | assumed
//     "requestsPerMinute": 30,
//     "requestsPerDay": 14400,
//     "tokensPerMinute": 6000,
//     "tokensPerDay": 500000,
//     "resetsAt": "00:00Z"        // daily reset, vendor's own time
//   }
export function freeTierOf(provider) {
  const tier = provider?.freeTier;
  if (!tier) return null;

  // `freeTier: true` is the legacy boolean from the original config — it means
  // "this vendor has a free tier" as documentation, and carries no limits.
  // Treating it as a declaration produced the worst possible reading: every
  // limit null, so headroom computed as 1.0 and the lane reported as having
  // plenty of free quota left. A quota we cannot count is not quota we can
  // drain, so it is not a declaration. `undeclaredFreeTiers()` keeps the
  // information rather than discarding it.
  if (typeof tier !== "object") return null;

  // The same reasoning applies to an object that declares no limits at all,
  // which is the shape you get part-way through filling a block in from the
  // vendor's docs: `{ "pool": "x-free", "poolConfidence": "known" }`. It is
  // not the legacy boolean, so the check above let it through, and every
  // limit then came out null, `declared` was empty, and headroom fell back to
  // 1.0. That is the imaginary-headroom reading this function exists to
  // prevent, arriving by a different door: the quota-headroom and drain-free
  // strategies would rank the lane as completely unused free capacity, and
  // undeclaredFreeTiers() would not warn because it also only tested the
  // boolean. A quota with no limits cannot be counted, so it is not a
  // declaration regardless of which shape it arrives in.
  const hasAnyLimit =
    tier.requestsPerMinute != null ||
    tier.requestsPerDay != null ||
    tier.tokensPerMinute != null ||
    tier.tokensPerDay != null;
  if (!hasAnyLimit) return null;

  return {
    pool: tier.pool || provider.id,
    poolConfidence: tier.poolConfidence === "known" ? "known" : "assumed",
    requestsPerMinute: tier.requestsPerMinute ?? null,
    requestsPerDay: tier.requestsPerDay ?? null,
    tokensPerMinute: tier.tokensPerMinute ?? null,
    tokensPerDay: tier.tokensPerDay ?? null,
    resetsAt: tier.resetsAt || null,
    // Same discipline as pricingVerified: a published limit nobody checked
    // against a real account is indicative, and a headroom figure computed
    // from a wrong limit is confidently wrong in whichever direction the
    // vendor moved. Under-declaring is the safe direction here, because the
    // router then stops using a lane that still had quota — annoying, not
    // expensive. Over-declaring means requests that fail upstream.
    limitsVerified: tier.limitsVerified === true
  };
}

export function isFreeTier(provider) {
  return freeTierOf(provider) !== null;
}

// Providers whose config says a free tier exists but declares no limits for it.
// Reported so the gap is visible and fixable — each is a `freeTier` block
// waiting to be filled in from the vendor's docs.
export function undeclaredFreeTiers() {
  // Anything the config says has a free tier that freeTierOf refused to treat
  // as one. Deriving it from freeTierOf rather than re-testing the shape here
  // is what keeps the two in step: the previous version tested only for the
  // legacy boolean, so a limitless object was silently absent from this list
  // while also reporting full headroom.
  return providers.filter((p) => p.freeTier && freeTierOf(p) === null).map((p) => p.id);
}

// Everything sharing this pool. Used by the panel to explain *why* two
// providers show the same remaining count, which otherwise looks like a bug.
export function poolMembers(pool) {
  return providers.filter((p) => freeTierOf(p)?.pool === pool).map((p) => p.id);
}

// ---- Counting ---------------------------------------------------------------

function bucket(pool) {
  if (!events.has(pool)) events.set(pool, { requests: [], tokens: [] });
  return events.get(pool);
}

// Drop events older than the longest window we care about. Called on every
// read and write, so the arrays stay bounded without a background timer.
function prune(entry, now) {
  const cutoff = now - DAY_MS;
  if (entry.requests.length && entry.requests[0] < cutoff) {
    entry.requests = entry.requests.filter((ts) => ts >= cutoff);
  }
  if (entry.tokens.length && entry.tokens[0]?.[0] < cutoff) {
    entry.tokens = entry.tokens.filter(([ts]) => ts >= cutoff);
  }
  return entry;
}

// The daily window. Where the vendor publishes a reset time, use it: a
// rolling 24h window would report quota as available hours before the vendor
// actually restores it, and the request then fails.
function dayStart(tier, now) {
  if (!tier?.resetsAt) return now - DAY_MS;
  const match = /^(\d{2}):(\d{2})Z$/.exec(tier.resetsAt);
  if (!match) return now - DAY_MS;
  const d = new Date(now);
  const reset = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    Number(match[1]),
    Number(match[2])
  );
  return reset <= now ? reset : reset - DAY_MS;
}

/**
 * Record consumption against a provider's free pool.
 *
 * Called for FAILED calls too — at essentially every vendor a request that
 * reached the API counted against the rate limit whatever it returned. Only
 * requests that never left this process are free, and those never get here.
 */
export function recordFreeUsage(providerId, { tokens = 0 } = {}) {
  const provider = providers.find((p) => p.id === providerId);
  const tier = freeTierOf(provider);
  if (!tier) return null;

  const now = Date.now();
  const entry = prune(bucket(tier.pool), now);
  entry.requests.push(now);
  if (tokens > 0) entry.tokens.push([now, tokens]);
  scheduleFlush();
  return tier.pool;
}

function sumSince(pairs, since) {
  let total = 0;
  for (const [ts, count] of pairs) if (ts >= since) total += count;
  return total;
}

function countSince(timestamps, since) {
  let total = 0;
  for (const ts of timestamps) if (ts >= since) total++;
  return total;
}

/**
 * Current state of one provider's free tier.
 *
 * `remaining` is per limit, and `exhausted` is true when ANY declared limit
 * is at zero — a provider with tokens left but no requests left is exhausted
 * in every way that matters to the router.
 */
export function quotaStatus(providerId) {
  const provider = providers.find((p) => p.id === providerId);
  const tier = freeTierOf(provider);
  if (!tier) return null;

  const now = Date.now();
  const entry = prune(bucket(tier.pool), now);
  const minuteAgo = now - MINUTE_MS;
  const since = dayStart(tier, now);

  const used = {
    requestsThisMinute: countSince(entry.requests, minuteAgo),
    requestsToday: countSince(entry.requests, since),
    tokensThisMinute: sumSince(entry.tokens, minuteAgo),
    tokensToday: sumSince(entry.tokens, since)
  };

  const limits = {
    requestsPerMinute: tier.requestsPerMinute,
    requestsPerDay: tier.requestsPerDay,
    tokensPerMinute: tier.tokensPerMinute,
    tokensPerDay: tier.tokensPerDay
  };

  const remaining = {
    requestsThisMinute: limits.requestsPerMinute === null ? null : Math.max(0, limits.requestsPerMinute - used.requestsThisMinute),
    requestsToday: limits.requestsPerDay === null ? null : Math.max(0, limits.requestsPerDay - used.requestsToday),
    tokensThisMinute: limits.tokensPerMinute === null ? null : Math.max(0, limits.tokensPerMinute - used.tokensThisMinute),
    tokensToday: limits.tokensPerDay === null ? null : Math.max(0, limits.tokensPerDay - used.tokensToday)
  };

  const declared = Object.entries(remaining).filter(([, v]) => v !== null);
  const exhausted = declared.some(([, v]) => v === 0);

  // A single 0-1 figure for routing. The tightest declared limit governs,
  // because that is the one that will actually reject the next request.
  const headroom = declared.length
    ? Math.min(
        ...declared.map(([k, v]) => {
          const limitKey = {
            requestsThisMinute: "requestsPerMinute",
            requestsToday: "requestsPerDay",
            tokensThisMinute: "tokensPerMinute",
            tokensToday: "tokensPerDay"
          }[k];
          const limit = limits[limitKey];
          return limit > 0 ? v / limit : 0;
        })
      )
    : 1;

  return {
    providerId,
    pool: tier.pool,
    poolConfidence: tier.poolConfidence,
    poolMembers: poolMembers(tier.pool),
    limits,
    used,
    remaining,
    headroom,
    exhausted,
    resetsAt: tier.resetsAt,
    limitsVerified: tier.limitsVerified,
    // Never omit this. Every figure above is what this gateway saw; usage of
    // the same key from another client is invisible here, so the real
    // remaining quota is always this or less, never more.
    observedOnly: true
  };
}

// Every declared free tier, plus the pool view. The pool view is the honest
// one — it is what actually gets consumed.
export function quotaSnapshot() {
  const perProvider = providers.filter(isFreeTier).map((p) => quotaStatus(p.id));

  const pools = {};
  for (const status of perProvider) {
    if (!pools[status.pool]) {
      pools[status.pool] = {
        pool: status.pool,
        confidence: status.poolConfidence,
        members: status.poolMembers,
        used: status.used,
        remaining: status.remaining,
        headroom: status.headroom,
        exhausted: status.exhausted
      };
    }
  }

  const freeRequests = Object.values(pools).reduce((n, p) => n + p.used.requestsToday, 0);
  const freeTokens = Object.values(pools).reduce((n, p) => n + p.used.tokensToday, 0);

  return {
    providers: perProvider,
    pools: Object.values(pools),
    totals: {
      declaredFreeProviders: perProvider.length,
      distinctPools: Object.keys(pools).length,
      // The gap between these two numbers IS the dedup. Reporting only the
      // provider count is how a gateway claims quota it does not have.
      dedupedAway: perProvider.length - Object.keys(pools).length,
      assumedPools: Object.values(pools).filter((p) => p.confidence === "assumed").length,
      unverifiedLimits: perProvider.filter((p) => !p.limitsVerified).length,
      // Not counted anywhere above — these have a free tier with no configured
      // limits, so there is nothing to count. Listed so the gap is actionable.
      undeclaredFreeTiers: undeclaredFreeTiers(),
      freeRequestsToday: freeRequests,
      freeTokensToday: freeTokens,
      exhaustedPools: Object.values(pools).filter((p) => p.exhausted).length
    },
    observedOnly: true
  };
}

export function resetQuota() {
  events.clear();
  dirty = true;
  flush();
}

// Test seam: forces the debounced write immediately.
export function flushQuota() {
  flush();
}
