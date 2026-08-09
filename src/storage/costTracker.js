import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../paths.js";

const logPath = path.join(dataDir, "usage.jsonl");

const RECENT_LIMIT = 20;

// Provider prices in config/providers.json are quoted PER MILLION TOKENS,
// matching how every vendor publishes them.
//
// This used to be 1000 while the config field was named `costPer1kTokens`
// and held per-million values — every recorded cost came out 1000x too
// high. The first live request made it obvious: 75 real tokens on Groq
// recorded as $0.0046 when the true cost was under $0.000005. Budget caps
// inherit the error directly, so a $5/month cap behaved like $0.005 and
// skipped the provider as "over budget" almost immediately.
//
// The field name now matches the unit, so config values can be copied
// straight off a vendor pricing page with no conversion step — which is
// the conversion that silently went missing.
// Prices are quoted per million tokens. Exported because gamification
// builds its baseline from the same rates, and a second copy of this divisor
// is a second thing to get wrong.
export const TOKENS_PER_PRICE_UNIT = 1_000_000;

// Aggregates are maintained incrementally in memory rather than recomputed
// by re-reading the whole log on every call. The old version re-read and
// re-parsed usage.jsonl once per *candidate provider* per request — up to
// 36 full file reads for a single `auto` request, against a file that only
// ever grows. Budget enforcement sits on the routing hot path, so that cost
// was paid on every completion.
const agg = {
  totalRequests: 0,
  totalCostUsd: 0,
  totalTokens: 0,
  byProvider: new Map(), // providerId -> { requests, costUsd, tokens, totalLatencyMs }
  monthly: new Map(), // `${providerId}::${YYYY-MM}` -> spend
  recent: [], // newest last, capped at RECENT_LIMIT
  corruptLines: 0,
  // Hourly buckets, so the chart can be a real time series instead of the
  // last 20 raw requests — which told you nothing about rate or trend.
  hourly: new Map(), // "YYYY-MM-DDTHH" -> { costUsd, tokens, requests }
  // How much of the recorded spend rests on the provider's own numbers
  // versus a local estimate. Without this the total reads as equally solid
  // throughout, which it isn't.
  reportedRequests: 0,
  estimatedRequests: 0,
  reportedCostUsd: 0,
  estimatedCostUsd: 0
};

const MAX_HOURLY_BUCKETS = 24 * 60; // ~60 days

// In-flight spend not yet committed to the log. Without this, N concurrent
// requests all read the same committed total and all pass a nearly-full cap
// — the check is only as good as its accounting window.
const reserved = new Map(); // `${providerId}::${YYYY-MM}` -> usd

// The month a spend figure belongs to. UTC, because that is what the ledger
// already records: every row's `ts` is an ISO string from toISOString(), and
// monthKeyOf slices YYYY-MM straight off it.
//
// currentMonthKey() used local time, and the two disagreed for the length of
// the UTC offset at every month boundary. On a UTC+2 machine, at 00:30 local
// on the 1st, the cap checked the new month's bucket while every request's
// spend was still being filed into the previous month's. So for those hours
// the cap read a bucket nothing was filling: the monthly budget, which is the
// whole point of this module, silently stopped being enforced once a month,
// and the new month's ledger under-reported by the same amount. Invisible to
// CI, which runs in UTC where the two happen to agree.
export function monthKeyOfDate(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthKeyOf(iso) {
  return typeof iso === "string" ? iso.slice(0, 7) : currentMonthKey();
}

function currentMonthKey() {
  return monthKeyOfDate();
}

function providerBucket(providerId) {
  if (!agg.byProvider.has(providerId)) {
    agg.byProvider.set(providerId, { requests: 0, costUsd: 0, tokens: 0, totalLatencyMs: 0 });
  }
  return agg.byProvider.get(providerId);
}

// A single truncated line — a crash mid-append, a full disk, a killed
// container — used to throw out of JSON.parse and take down every
// completion request AND the panel with a 500. One bad byte should cost
// one row of history, not the gateway.
function applyEntry(e) {
  if (!e || typeof e !== "object" || typeof e.providerId !== "string") return false;

  const cost = Number.isFinite(e.costUsd) ? e.costUsd : 0;
  const prompt = Number.isFinite(e.promptTokens) ? e.promptTokens : 0;
  const completion = Number.isFinite(e.completionTokens) ? e.completionTokens : 0;
  const latency = Number.isFinite(e.latencyMs) ? e.latencyMs : 0;

  const bucket = providerBucket(e.providerId);
  bucket.requests += 1;
  bucket.costUsd += cost;
  bucket.tokens += prompt + completion;
  bucket.totalLatencyMs += latency;

  agg.totalRequests += 1;
  agg.totalCostUsd += cost;
  agg.totalTokens += prompt + completion;

  const mk = `${e.providerId}::${monthKeyOf(e.ts)}`;
  agg.monthly.set(mk, (agg.monthly.get(mk) || 0) + cost);

  const hourKey = typeof e.ts === "string" ? e.ts.slice(0, 13) : new Date().toISOString().slice(0, 13);
  const hourBucket = agg.hourly.get(hourKey) || { costUsd: 0, tokens: 0, requests: 0 };
  hourBucket.costUsd += cost;
  hourBucket.tokens += prompt + completion;
  hourBucket.requests += 1;
  agg.hourly.set(hourKey, hourBucket);
  if (agg.hourly.size > MAX_HOURLY_BUCKETS) agg.hourly.delete(agg.hourly.keys().next().value);

  if (e.estimated === true) {
    agg.estimatedRequests += 1;
    agg.estimatedCostUsd += cost;
  } else {
    agg.reportedRequests += 1;
    agg.reportedCostUsd += cost;
  }

  agg.recent.push(e);
  if (agg.recent.length > RECENT_LIMIT) agg.recent.shift();
  return true;
}

function load() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, "", { mode: 0o600 });
    return;
  }
  const lines = fs.readFileSync(logPath, "utf-8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      agg.corruptLines += 1; // skip and keep going
      continue;
    }
    if (!applyEntry(parsed)) agg.corruptLines += 1;
  }
}

load();

export function recordUsage({ providerId, model, usage, latencyMs, costPer1mTokens }) {
  // A provider that omits `usage` must not silently record as free. Coerce
  // to 0 explicitly so the arithmetic can never produce NaN, which used to
  // serialize to JSON `null` and vanish from budget accounting entirely.
  const promptTokens = Number.isFinite(usage?.prompt_tokens) ? usage.prompt_tokens : 0;
  const completionTokens = Number.isFinite(usage?.completion_tokens) ? usage.completion_tokens : 0;

  const inputCost = (promptTokens / TOKENS_PER_PRICE_UNIT) * (costPer1mTokens?.input || 0);
  const outputCost = (completionTokens / TOKENS_PER_PRICE_UNIT) * (costPer1mTokens?.output || 0);
  // 8dp, not 6: at real per-million rates a short cheap call costs well
  // under a millionth of a dollar, and rounding to 6dp recorded it as $0.
  const costUsd = Number((inputCost + outputCost).toFixed(8));

  const entry = {
    ts: new Date().toISOString(),
    providerId,
    model,
    promptTokens,
    completionTokens,
    costUsd: Number.isFinite(costUsd) ? costUsd : 0,
    latencyMs: Number.isFinite(latencyMs) ? latencyMs : 0,
    // Marks rows whose token counts came from a local estimate rather than
    // the provider's own reporting, so spend figures can be read honestly.
    estimated: usage?.estimated === true ? true : undefined
  };

  try {
    fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
  } catch (err) {
    // Losing durability must not lose the request. Keep the in-memory
    // accounting correct and surface the problem via stats().
    agg.corruptLines += 1;
    console.error(`[costTracker] failed to append usage log: ${err.message}`);
  }

  applyEntry(entry);
  return entry;
}

export function getUsageSummary() {
  const byProvider = {};
  for (const [id, b] of agg.byProvider) {
    byProvider[id] = {
      requests: b.requests,
      // 8dp throughout. At real per-million rates a whole day of light use
      // can total well under a cent, and 4dp rounded every such figure to
      // $0.0000 — which reads as "this is free" rather than "this is small",
      // and is exactly the wrong impression for a spend-control tool.
      costUsd: Number(b.costUsd.toFixed(8)),
      tokens: b.tokens,
      avgLatencyMs: b.requests > 0 ? Math.round(b.totalLatencyMs / b.requests) : 0
    };
  }

  return {
    totalRequests: agg.totalRequests,
    totalCostUsd: Number(agg.totalCostUsd.toFixed(8)),
    totalTokens: agg.totalTokens,
    byProvider,
    recent: [...agg.recent].reverse(),
    corruptLines: agg.corruptLines,
    confidence: {
      reportedRequests: agg.reportedRequests,
      estimatedRequests: agg.estimatedRequests,
      reportedCostUsd: Number(agg.reportedCostUsd.toFixed(8)),
      estimatedCostUsd: Number(agg.estimatedCostUsd.toFixed(8)),
      // Share of SPEND (not request count) backed by the provider's own
      // accounting. Request count would flatter the number, since the
      // cheapest calls are the ones most likely to be measured.
      // null, not 100, when nothing has been measured yet. A fresh install has
      // no figures at all, and answering "100% of them are provider-backed"
      // is the exact failure this project treats as the serious one: an output
      // that looks more confident than its inputs justify. Callers render null
      // as the no-reading glyph.
      reportedPct:
        agg.totalCostUsd > 0
          ? Math.round((agg.reportedCostUsd / agg.totalCostUsd) * 100)
          : agg.totalRequests > 0
            ? Math.round((agg.reportedRequests / agg.totalRequests) * 100)
            : null
    }
  };
}

// Time series for the chart. `bucket` is "hour" or "day"; returns oldest
// first, gaps filled with zeros so the x-axis is real time rather than
// "whenever a request happened".
export function getUsageSeries({ bucket = "hour", points = 24 } = {}) {
  const stepMs = bucket === "day" ? 86_400_000 : 3_600_000;
  const keyOf = (d) => (bucket === "day" ? d.toISOString().slice(0, 10) : d.toISOString().slice(0, 13));

  const totals = new Map();
  for (const [hourKey, v] of agg.hourly) {
    const k = bucket === "day" ? hourKey.slice(0, 10) : hourKey;
    const acc = totals.get(k) || { costUsd: 0, tokens: 0, requests: 0 };
    acc.costUsd += v.costUsd;
    acc.tokens += v.tokens;
    acc.requests += v.requests;
    totals.set(k, acc);
  }

  const now = Date.now();
  const out = [];
  for (let i = points - 1; i >= 0; i--) {
    const at = new Date(now - i * stepMs);
    const k = keyOf(at);
    const v = totals.get(k) || { costUsd: 0, tokens: 0, requests: 0 };
    out.push({ key: k, at: at.toISOString(), costUsd: Number(v.costUsd.toFixed(8)), tokens: v.tokens, requests: v.requests });
  }
  return out;
}

// Everything needed to reconcile against a vendor invoice: one row per
// provider per month. "Does the gateway's number match my bill?" is the
// question that makes any of this spend tracking worth trusting.
export function getLedger(monthKey = currentMonthKey()) {
  const rows = [];
  for (const [k, spend] of agg.monthly) {
    const [providerId, month] = k.split("::");
    if (month !== monthKey) continue;
    rows.push({ providerId, month, costUsd: Number(spend.toFixed(8)) });
  }
  rows.sort((a, b) => b.costUsd - a.costUsd);
  return { month: monthKey, rows, totalUsd: Number(rows.reduce((a, r) => a + r.costUsd, 0).toFixed(8)) };
}

// Committed spend for the current calendar month, plus anything reserved
// for requests still in flight.
export function getMonthlySpend(providerId) {
  const mk = `${providerId}::${currentMonthKey()}`;
  const total = (agg.monthly.get(mk) || 0) + (reserved.get(mk) || 0);
  return Number(total.toFixed(8));
}

// Reserve an estimated cost before dispatching, release it once the real
// figure is recorded. Closes the window where concurrent requests each see
// a cap as "not yet reached" and collectively blow through it.
export function reserveSpend(providerId, estimatedUsd) {
  if (!Number.isFinite(estimatedUsd) || estimatedUsd <= 0) return () => {};
  const mk = `${providerId}::${currentMonthKey()}`;
  reserved.set(mk, (reserved.get(mk) || 0) + estimatedUsd);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (reserved.get(mk) || 0) - estimatedUsd;
    if (next > 0.000001) reserved.set(mk, next);
    else reserved.delete(mk);
  };
}

// Rough pre-flight cost estimate used only for the reservation above.
export function estimateRequestCost(request, costPer1mTokens) {
  const chars = JSON.stringify(request?.messages || "").length;
  const promptTokens = Math.ceil(chars / 4);
  const completionTokens = Number.isFinite(request?.max_tokens) ? request.max_tokens : 512;
  return (
    (promptTokens / TOKENS_PER_PRICE_UNIT) * (costPer1mTokens?.input || 0) +
    (completionTokens / TOKENS_PER_PRICE_UNIT) * (costPer1mTokens?.output || 0)
  );
}

// Test seam: reload aggregates from disk (used after fixtures rewrite the log).
export function reload() {
  agg.totalRequests = 0;
  agg.totalCostUsd = 0;
  agg.totalTokens = 0;
  agg.byProvider.clear();
  agg.monthly.clear();
  agg.recent.length = 0;
  agg.corruptLines = 0;
  agg.hourly.clear();
  agg.reportedRequests = 0;
  agg.estimatedRequests = 0;
  agg.reportedCostUsd = 0;
  agg.estimatedCostUsd = 0;
  reserved.clear();
  load();
}
