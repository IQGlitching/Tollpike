import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../paths.js";
import { ledgerKey } from "../security/crypto.js";

const logPath = path.join(dataDir, "usage.jsonl");
// Sidecar anchoring the chain's head hash and length. The in-file chain alone
// cannot catch a truncation, deleting the most recent rows leaves a shorter
// chain that still verifies against itself. The anchor closes that: on load,
// a file shorter than the anchor claims is a deletion. In keyed mode the
// anchor carries its own HMAC tag, so an attacker who truncates the log
// cannot also forge an anchor that agrees with the shorter file.
const headPath = path.join(dataDir, "usage.head");

// The fixed value the first row chains from. Public by design: the tamper
// evidence comes from the key in chainHashWith(), not from hiding this.
const GENESIS = "tollpike-ledger-v1";

const RECENT_LIMIT = 20;

// Provider prices in config/providers.json are quoted PER MILLION TOKENS,
// matching how every vendor publishes them.
//
// This used to be 1000 while the config field was named `costPer1kTokens`
// and held per-million values, every recorded cost came out 1000x too
// high. The first live request made it obvious: 75 real tokens on Groq
// recorded as $0.0046 when the true cost was under $0.000005. Budget caps
// inherit the error directly, so a $5/month cap behaved like $0.005 and
// skipped the provider as "over budget" almost immediately.
//
// The field name now matches the unit, so config values can be copied
// straight off a vendor pricing page with no conversion step, which is
// the conversion that silently went missing.
// Prices are quoted per million tokens. Exported because gamification
// builds its baseline from the same rates, and a second copy of this divisor
// is a second thing to get wrong.
export const TOKENS_PER_PRICE_UNIT = 1_000_000;

// Aggregates are maintained incrementally in memory rather than recomputed
// by re-reading the whole log on every call. The old version re-read and
// re-parsed usage.jsonl once per *candidate provider* per request, up to
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
  // last 20 raw requests, which told you nothing about rate or trend.
  hourly: new Map(), // "YYYY-MM-DDTHH" -> { costUsd, tokens, requests }
  // How much of the recorded spend rests on the provider's own numbers
  // versus a local estimate. Without this the total reads as equally solid
  // throughout, which it isn't.
  reportedRequests: 0,
  estimatedRequests: 0,
  reportedCostUsd: 0,
  estimatedCostUsd: 0,
  // Running head of the tamper-evident hash chain: the next appended row is
  // sealed against this value. Recomputed from disk on load, advanced on each
  // successful append. `integrity` is the load-time verification snapshot the
  // panel polls; verifyLedger() re-reads disk for an authoritative check.
  chainHead: GENESIS,
  integrity: null
};

const MAX_HOURLY_BUCKETS = 24 * 60; // ~60 days

// In-flight spend not yet committed to the log. Without this, N concurrent
// requests all read the same committed total and all pass a nearly-full cap
//, the check is only as good as its accounting window.
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

// A single truncated line, a crash mid-append, a full disk, a killed
// container, used to throw out of JSON.parse and take down every
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

// ===========================================================================
// Tamper-evident hash chain over the ledger.
//
// Each row carries `h`, an HMAC over the previous row's `h` and this row's
// canonical payload. Editing, reordering, inserting or deleting any row
// breaks the chain from that point, and the break is detected on read. Keyed
// with a secret that lives outside the data directory, so forging a
// consistent history requires more than write access to usage.jsonl.
//
// This is integrity, not confidentiality: the rows stay plainly readable. It
// is also single-writer, two processes sharing one data dir would interleave
// appends and corrupt the chain, which is why a second instance must set its
// own TOLLPIKE_DATA_DIR (the same rule the rest of this module already
// assumes for its in-memory aggregates).
// ===========================================================================

// Deterministic serialization of a row's payload, excluding the chain field
// `h`. Keys are sorted so re-serializing a parsed row reproduces the exact
// bytes hashed at write time regardless of key order on disk, and
// undefined-valued fields are dropped to match JSON.stringify, so an absent
// `estimated` hashes identically whether it was omitted or written.
function canonicalPayload(row) {
  const keys = Object.keys(row).filter((k) => k !== "h" && row[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + JSON.stringify(row[k])).join(",") + "}";
}

// h = MAC(prevHead + "\n" + canonicalPayload). HMAC-SHA256 keyed with
// ledgerKey() when a secret is set; a bare SHA-256 otherwise. The unkeyed
// form still chains, so a naive edit is caught at the next row, but it is
// forgeable by anyone who can rewrite the whole tail, which is why the
// report says `keyed: false` and nothing claims tamper-evidence without it.
function chainHashWith(key, prevHead, canon) {
  const input = prevHead + "\n" + canon;
  return key
    ? crypto.createHmac("sha256", key).update(input).digest("hex")
    : crypto.createHash("sha256").update(input).digest("hex");
}

// Constant-time hex compare. This is MAC verification, the stored value is
// attacker-controlled and the key is secret, so it gets the same treatment
// as the gateway-key check. Length or encoding mismatch is a plain false.
function hexEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || a.length === 0) {
    return false;
  }
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

function anchorTag(key, count, head) {
  return crypto.createHmac("sha256", key).update(`${count}:${head}`).digest("hex");
}

function readAnchor() {
  try {
    if (!fs.existsSync(headPath)) return null;
    const a = JSON.parse(fs.readFileSync(headPath, "utf-8"));
    if (!a || typeof a.count !== "number" || typeof a.head !== "string") return null;
    return a;
  } catch {
    return null;
  }
}

// Written after the row it anchors, never before, so a crash between the two
// leaves the anchor lagging by a row, a state verification reads as a pending
// append, never as a truncation. Best-effort: a failed anchor write must not
// lose the request that triggered it.
function writeAnchor(count, head) {
  const key = ledgerKey();
  const anchor = { v: 1, count, head };
  if (key) anchor.tag = anchorTag(key, count, head);
  try {
    const tmp = headPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(anchor), { mode: 0o600 });
    fs.renameSync(tmp, headPath);
  } catch (err) {
    console.error(`[costTracker] failed to write usage head anchor: ${err.message}`);
  }
}

// Walk the raw ledger text and verify every chained row. Rows with no `h`
// that precede the first chained row are the pre-chain prefix (a ledger that
// predates this feature) and are reported as `unchained`, not as damage. A
// no-h row appearing *after* the chain has begun is a break, a chained row
// was removed or replaced. `anchorCount` lets the walk capture the running
// head at exactly that length for the truncation check.
function walkChain(rawText, anchorCount) {
  const key = ledgerKey();
  let head = GENESIS;
  let chained = 0;
  let unchained = 0;
  let brokenLinks = 0;
  let started = false;
  const brokenAt = [];
  let headAtAnchor = anchorCount === 0 ? GENESIS : null;

  for (const line of rawText.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // unparsable lines are counted by the accounting loader, not here
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;

    const idx = chained + unchained;
    if (typeof row.h !== "string") {
      if (started) {
        brokenLinks += 1;
        brokenAt.push(idx);
      } else {
        unchained += 1;
      }
      continue;
    }

    started = true;
    const expected = chainHashWith(key, head, canonicalPayload(row));
    if (!hexEqual(expected, row.h)) {
      brokenLinks += 1;
      brokenAt.push(idx);
    }
    // Continue from the stored head, not the recomputed one, so a single
    // altered row flags only itself (and the row after it) rather than
    // cascading a break through the entire remaining chain.
    head = row.h;
    chained += 1;
    if (chained === anchorCount) headAtAnchor = head;
  }

  return { keyed: Boolean(key), head, chained, unchained, brokenLinks, brokenAt, headAtAnchor };
}

// The single verification derivation, used by both the load-time snapshot and
// the on-demand verifyLedger(). chainOk is null (not true) when nothing is
// chained yet, matching the reportedPct precedent: a fresh ledger has nothing
// to vouch for, and answering "intact" would claim more than the inputs hold.
function buildReport(rawText) {
  const anchor = readAnchor();
  const anchorCount = anchor ? anchor.count : -1; // -1 never equals a real length
  const walk = walkChain(rawText, anchorCount);
  const key = ledgerKey();

  let anchored = false;
  let anchorOk = null;
  let truncated = false;
  let rolledBack = false;
  if (anchor) {
    anchored = true;
    if (key) anchorOk = hexEqual(anchorTag(key, anchor.count, anchor.head), anchor.tag || "");
    if (anchorOk !== false) {
      if (walk.chained < anchor.count) {
        truncated = true; // recent rows deleted
      } else if (walk.headAtAnchor !== null && walk.headAtAnchor !== anchor.head) {
        rolledBack = true; // tail replaced with a different, self-consistent chain
      }
      // chained > anchor.count with a matching head at that point is the
      // benign lagging-anchor case above, not tamper.
    }
  }

  const tamper = walk.brokenLinks > 0 || truncated || rolledBack || anchorOk === false;
  return {
    keyed: walk.keyed,
    algo: walk.keyed ? "hmac-sha256" : "sha256",
    total: walk.chained + walk.unchained,
    chained: walk.chained,
    unchained: walk.unchained,
    brokenLinks: walk.brokenLinks,
    brokenAt: walk.brokenAt,
    anchored,
    anchorOk,
    truncated,
    rolledBack,
    chainOk: walk.chained === 0 ? null : !tamper,
    intact: !tamper,
    head: walk.head
  };
}

function finalizeIntegrity(rawText) {
  const report = buildReport(rawText);
  agg.chainHead = report.head;
  agg.integrity = report;
}

function load() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, "", { mode: 0o600 });
    finalizeIntegrity("");
    return;
  }
  const raw = fs.readFileSync(logPath, "utf-8");
  for (const line of raw.split("\n")) {
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
  // Verify the chain from the same bytes we just accounted, so the panel gets
  // an integrity reading with no second read on the boot path.
  finalizeIntegrity(raw);
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

  // Seal the row into the hash chain before writing. `h` commits to the
  // previous head and this row's canonical payload. It is written to disk but
  // kept out of the in-memory accounting entry, which has no use for it.
  const h = chainHashWith(ledgerKey(), agg.chainHead, canonicalPayload(entry));

  let appended = false;
  try {
    fs.appendFileSync(logPath, JSON.stringify({ ...entry, h }) + "\n");
    appended = true;
  } catch (err) {
    // Losing durability must not lose the request. Keep the in-memory
    // accounting correct and surface the problem via stats().
    agg.corruptLines += 1;
    console.error(`[costTracker] failed to append usage log: ${err.message}`);
  }

  if (appended) {
    // Advance the chain only once the row is on disk, so the in-memory head
    // never runs ahead of what a reader would find, and anchor the new head
    // after the row (never before, see writeAnchor). A row that failed to
    // write is deliberately not chained: the next row seals against the last
    // durable head, and verification treats the gap as a lagging anchor.
    agg.chainHead = h;
    if (agg.integrity) {
      agg.integrity.chained += 1;
      agg.integrity.total += 1;
      agg.integrity.head = h;
      if (agg.integrity.chainOk === null) agg.integrity.chainOk = agg.integrity.brokenLinks === 0;
      agg.integrity.intact =
        agg.integrity.brokenLinks === 0 &&
        !agg.integrity.truncated &&
        !agg.integrity.rolledBack &&
        agg.integrity.anchorOk !== false;
      writeAnchor(agg.integrity.chained, h);
    }
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
      // $0.0000, which reads as "this is free" rather than "this is small",
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
    // Load-time snapshot of the hash-chain verification, cheap for the panel
    // to poll on every refresh. verifyLedger() re-reads disk for a check that
    // also catches a file edited while the process is running. Copied out so a
    // caller cannot mutate the aggregate through the reference.
    integrity: agg.integrity
      ? { ...agg.integrity, brokenAt: [...agg.integrity.brokenAt] }
      : null,
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

// Authoritative integrity check: re-reads usage.jsonl and the anchor from
// disk and verifies the whole chain, so an edit made after boot is caught
// (the load-time snapshot in getUsageSummary would not see it). Read-only ,
// no writes, no anchor update, so it is safe on the MCP read-only surface.
//
// Report fields:
//   keyed        HMAC-keyed with TOLLPIKE_SECRET (true) or a bare SHA-256 (false)
//   algo         "hmac-sha256" or "sha256"
//   chained      rows sealed into the chain
//   unchained    pre-chain rows that predate this feature (not damage)
//   brokenLinks  chained rows whose hash does not match; brokenAt lists indices
//   truncated    fewer chained rows than the anchor recorded (recent rows deleted)
//   rolledBack   the tail was replaced with a different, self-consistent chain
//   anchorOk     anchor HMAC verified (keyed only; null when unkeyed or absent)
//   chainOk      true/false, or null when nothing is chained yet
//   intact       chainOk with no truncation, rollback or forged anchor
export function verifyLedger() {
  const raw = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
  return buildReport(raw);
}

// Retroactively seal a ledger that predates the hash chain: recompute `h` for
// every row from GENESIS forward, so a file with a pre-chain prefix becomes
// one consistent chain. Operator-initiated only (the `--seal` opt-in), because
// it is a read-modify-write over real spend history, the same class of
// operation that once wrote null over the gateway key.
//
// Refuses in the two cases where sealing would do harm rather than good:
//   - the ledger already fails verification: resealing recomputes every hash,
//     which would overwrite the evidence and mint a clean chain over altered
//     numbers. Investigate first.
//   - unparsable lines are present: they cannot be sealed, and silently
//     dropping them would lose data. Fix them first.
// Writes a .pre-seal.bak alongside the ledger, replaces it atomically, then
// rebuilds the in-memory aggregates. Returns { ok, ... } rather than throwing.
export function sealLedger() {
  const raw = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";

  const before = buildReport(raw);
  if (before.intact === false) {
    return { ok: false, reason: "verification-failed", report: before };
  }

  const rows = [];
  let unparsable = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!row || typeof row !== "object" || Array.isArray(row)) unparsable += 1;
      else rows.push(row);
    } catch {
      unparsable += 1;
    }
  }
  if (unparsable > 0) {
    return { ok: false, reason: "unparsable-lines", unparsable };
  }

  const toSeal = rows.filter((r) => typeof r.h !== "string").length;
  if (toSeal === 0) {
    return { ok: true, sealed: 0, total: rows.length, note: "already fully sealed" };
  }

  const key = ledgerKey();
  let head = GENESIS;
  const out = rows.map((row) => {
    const { h, ...payload } = row; // eslint-disable-line no-unused-vars
    head = chainHashWith(key, head, canonicalPayload(payload));
    return JSON.stringify({ ...payload, h: head });
  });

  const backupPath = logPath + ".pre-seal.bak";
  try {
    fs.writeFileSync(backupPath, raw, { mode: 0o600 });
    const tmp = logPath + ".seal.tmp";
    fs.writeFileSync(tmp, out.join("\n") + "\n", { mode: 0o600 });
    fs.renameSync(tmp, logPath);
    writeAnchor(out.length, head);
  } catch (err) {
    return { ok: false, reason: "write-failed", error: err.message };
  }

  reload(); // rebuild aggregates and the integrity snapshot from the sealed file
  return { ok: true, sealed: toSeal, total: rows.length, keyed: Boolean(key), backup: backupPath };
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
  agg.chainHead = GENESIS;
  agg.integrity = null;
  reserved.clear();
  load();
}
