#!/usr/bin/env node
// Diffs config/providers.json against upstream pricing and reports drift.
//
// This exists because a one-off price audit is worthless three months later.
// Model ids and rates both drift constantly — of the six providers checked by
// hand on 2026-08-08, two were listing model ids the vendor no longer served.
// A cap enforced against a stale table is decoration, so staleness has to be
// a first-class, machine-checkable state rather than something you remember
// to re-check.
//
//   npm run verify-pricing              report drift, exit 1 if any
//   npm run verify-pricing -- --write   apply first-party rates, stamp the date
//   npm run verify-pricing -- --json    machine-readable output for CI
//
// Exit codes: 0 clean · 1 drift or stale · 2 could not reach the source.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const providersPath = path.join(root, "config", "providers.json");
const sourcesPath = path.join(root, "config", "pricing-sources.json");

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const JSON_OUT = args.includes("--json");
const only = args.find((a) => !a.startsWith("--"));

const CATALOGUE_URL = "https://openrouter.ai/api/v1/models";
const ENDPOINTS_URL = (id) => `https://openrouter.ai/api/v1/models/${id}/endpoints`;
const ENDPOINT_CONCURRENCY = 8;

const providersFile = JSON.parse(fs.readFileSync(providersPath, "utf8"));
const sources = JSON.parse(fs.readFileSync(sourcesPath, "utf8"));
const TOLERANCE_PCT = sources.tolerancePct ?? 1;
const MAX_AGE_DAYS = sources.maxAgeDays ?? 90;

const C = process.stdout.isTTY && !JSON_OUT
  ? { dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", bold: "\x1b[1m", off: "\x1b[0m" }
  : new Proxy({}, { get: () => "" });

const today = new Date().toISOString().slice(0, 10);

async function fetchCatalogue() {
  const res = await fetch(CATALOGUE_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`catalogue returned HTTP ${res.status}`);
  const body = await res.json();
  const byId = new Map();
  for (const m of body.data || []) {
    // Catalogue prices are USD per token; config is USD per million.
    byId.set(m.id, {
      input: Number(m.pricing?.prompt) * 1e6,
      output: Number(m.pricing?.completion) * 1e6
    });
  }
  return byId;
}

// Per-host rates for one catalogue model, keyed by the host's display name.
//
// The top-level catalogue price is whichever endpoint OpenRouter would pick —
// usually the cheapest. Checking a re-host against that number says almost
// nothing: Together serves llama-3.3-70b at $1.04 while DeepInfra serves the
// same weights at $0.10, and both are correct. A re-host can only be verified
// against its OWN endpoint, which is what this fetches. Without it, two thirds
// of the lanes in this repo can never be anything but "unverified", and a cap
// set on them is enforced against a number nobody checked.
async function fetchEndpoints(catalogueId) {
  const res = await fetch(ENDPOINTS_URL(catalogueId), { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return null;
  const body = await res.json();
  const byHost = new Map();
  for (const e of body.data?.endpoints || []) {
    // Several hosts publish more than one endpoint for a model (quantisations,
    // context tiers). Keep the cheapest — it is the one a router reaches first,
    // and it is the conservative choice for a spend cap.
    const rate = {
      input: Number(e.pricing?.prompt) * 1e6,
      output: Number(e.pricing?.completion) * 1e6,
      contextLength: e.context_length ?? null
    };
    const seen = byHost.get(e.provider_name);
    if (!seen || rate.input < seen.input) byHost.set(e.provider_name, rate);
  }
  return byHost;
}

async function fetchEndpointIndex(ids) {
  const index = new Map();
  const list = [...ids];
  for (let i = 0; i < list.length; i += ENDPOINT_CONCURRENCY) {
    const batch = list.slice(i, i + ENDPOINT_CONCURRENCY);
    const done = await Promise.all(batch.map(async (id) => {
      try { return [id, await fetchEndpoints(id)]; } catch { return [id, null]; }
    }));
    for (const [id, hosts] of done) index.set(id, hosts);
  }
  return index;
}

const pctDiff = (a, b) => (b === 0 ? (a === 0 ? 0 : Infinity) : Math.abs((a - b) / b) * 100);

function ageDays(stamp) {
  if (typeof stamp !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(stamp)) return null;
  return Math.floor((Date.now() - Date.parse(stamp)) / 86_400_000);
}

function checkProvider(provider, source, catalogue, endpointIndex) {
  const rows = [];
  const kind = source?.kind ?? "unmapped";

  if (provider.category === "local") {
    return [{ provider: provider.id, model: "—", kind: "local", status: "ok", note: "runs on your hardware; genuinely free" }];
  }

  // A re-host, checked against its own published endpoint rather than the
  // catalogue's headline price. Same statuses as first-party so --write, the
  // exit code and the summary all treat them identically.
  if (kind === "third-party-host" && source.endpointProvider && Object.keys(source.models || {}).length) {
    for (const model of provider.models) {
      const mapped = source.models[model];
      if (!mapped) {
        rows.push({ provider: provider.id, model, kind, status: "unmapped", note: "no endpoint mapping — add one to pricing-sources.json" });
        continue;
      }
      const hosts = endpointIndex.get(mapped);
      if (!hosts) {
        rows.push({ provider: provider.id, model, kind, status: "gone", note: `"${mapped}" has no endpoint listing — model id is probably stale` });
        continue;
      }
      const upstream = hosts.get(source.endpointProvider);
      if (!upstream) {
        // The host stopped serving this model. Routing to it will 404 while
        // the allowlist rejects whatever replaced it — the same silent break
        // a stale first-party id causes.
        rows.push({
          provider: provider.id, model, kind, status: "gone",
          note: `${source.endpointProvider} no longer serves "${mapped}" (hosts: ${[...hosts.keys()].slice(0, 4).join(", ")}…)`
        });
        continue;
      }
      const current = provider.modelPricing?.[model] || provider.costPer1mTokens;
      const drifted = pctDiff(current.input, upstream.input) > TOLERANCE_PCT
        || pctDiff(current.output, upstream.output) > TOLERANCE_PCT;
      rows.push({
        provider: provider.id, model, kind,
        status: drifted ? "drift" : "ok",
        config: current, upstream,
        note: drifted
          ? `config ${current.input}/${current.output} vs ${source.endpointProvider} ${upstream.input.toFixed(3)}/${upstream.output.toFixed(3)}`
          : ""
      });
    }
    return rows;
  }

  if (kind === "first-party" && Object.keys(source.models || {}).length) {
    for (const model of provider.models) {
      const mapped = source.models[model];
      if (!mapped) {
        rows.push({ provider: provider.id, model, kind, status: "unmapped", note: "no catalogue mapping — add one to pricing-sources.json" });
        continue;
      }
      const upstream = catalogue.get(mapped);
      if (!upstream) {
        // The vendor no longer serves this id under that name. This is the
        // failure that silently breaks routing: the model 404s upstream while
        // the allowlist rejects whatever replaced it.
        rows.push({ provider: provider.id, model, kind, status: "gone", note: `"${mapped}" is no longer in the catalogue — model id is probably stale` });
        continue;
      }
      const current = provider.modelPricing?.[model] || provider.costPer1mTokens;
      const dIn = pctDiff(current.input, upstream.input);
      const dOut = pctDiff(current.output, upstream.output);
      const drifted = dIn > TOLERANCE_PCT || dOut > TOLERANCE_PCT;
      rows.push({
        provider: provider.id, model, kind,
        status: drifted ? "drift" : "ok",
        config: current, upstream,
        note: drifted ? `config ${current.input}/${current.output} vs upstream ${upstream.input.toFixed(3)}/${upstream.output.toFixed(3)}` : ""
      });
    }
    return rows;
  }

  // Everything else can only be checked by a human on the vendor's page, so
  // report how old that check is instead of implying it was re-verified.
  const age = ageDays(provider.pricingVerified);
  const zeroPriced = !provider.costPer1mTokens?.input && !provider.costPer1mTokens?.output;
  let status = "manual";
  let note = source?.docs ? `check ${source.docs}` : "no pricing source recorded";

  if (provider.pricingVerified === false || age === null) {
    status = "unverified";
    note = `never verified — ${source?.docs || "no source URL on file"}`;
  } else if (age > MAX_AGE_DAYS) {
    status = "stale";
    note = `last checked ${age}d ago (limit ${MAX_AGE_DAYS}d) — ${source?.docs || ""}`;
  }
  if (zeroPriced) {
    status = "unenforceable";
    note = `priced 0/0, so recorded spend is always $0 and a cap can never trip — ${source?.docs || ""}`;
  }
  return [{ provider: provider.id, model: provider.models[0] || "—", kind, status, note }];
}

const ICON = {
  ok: `${C.green}ok${C.off}`,
  drift: `${C.red}DRIFT${C.off}`,
  gone: `${C.red}STALE ID${C.off}`,
  unenforceable: `${C.red}NO CAP${C.off}`,
  unverified: `${C.yellow}unverified${C.off}`,
  stale: `${C.yellow}stale${C.off}`,
  manual: `${C.cyan}manual${C.off}`,
  unmapped: `${C.yellow}unmapped${C.off}`,
  local: `${C.dim}local${C.off}`
};

let catalogue;
try {
  catalogue = await fetchCatalogue();
} catch (err) {
  if (JSON_OUT) console.log(JSON.stringify({ ok: false, error: err.message }));
  else console.error(`${C.red}Could not reach the pricing catalogue:${C.off} ${err.message}`);
  process.exit(2);
}

const targets = providersFile.providers.filter((p) => !only || p.id === only);

// One endpoint fetch per distinct catalogue model, shared across every host
// that re-serves it — llama-3.3-70b alone is mapped by eight lanes here.
const endpointIds = new Set();
for (const p of targets) {
  const src = sources.providers[p.id];
  if (src?.kind !== "third-party-host" || !src.endpointProvider) continue;
  for (const model of p.models) if (src.models?.[model]) endpointIds.add(src.models[model]);
}
let endpointIndex = new Map();
if (endpointIds.size) {
  if (!JSON_OUT) console.log(`${C.dim}Fetching per-host rates for ${endpointIds.size} model(s)…${C.off}`);
  endpointIndex = await fetchEndpointIndex(endpointIds);
}

const rows = targets.flatMap((p) => checkProvider(p, sources.providers[p.id], catalogue, endpointIndex));

if (WRITE) {
  let applied = 0;
  for (const row of rows) {
    if (row.status !== "drift") continue;
    const provider = providersFile.providers.find((p) => p.id === row.provider);
    provider.modelPricing ||= {};
    provider.modelPricing[row.model] = {
      input: Number(row.upstream.input.toFixed(4)),
      output: Number(row.upstream.output.toFixed(4))
    };
    if (provider.models[0] === row.model) provider.costPer1mTokens = { ...provider.modelPricing[row.model] };
    provider.pricingVerified = today;
    provider.pricingSource = row.kind === "third-party-host" ? "openrouter-endpoints" : "openrouter-catalogue";
    applied++;
  }
  // A clean check is still a check: restamp so it doesn't age out. Both
  // machine-checkable kinds qualify — a re-host verified against its own
  // endpoint is exactly as checked as a first-party rate, and leaving it
  // stamped `false` would keep warning about a lane that was just confirmed.
  const MACHINE_CHECKED = new Set(["first-party", "third-party-host"]);
  for (const p of providersFile.providers) {
    const theseRows = rows.filter((r) => r.provider === p.id);
    if (theseRows.length && theseRows.every((r) => r.status === "ok") && MACHINE_CHECKED.has(theseRows[0].kind)) {
      p.pricingVerified = today;
      p.pricingSource = theseRows[0].kind === "third-party-host" ? "openrouter-endpoints" : "openrouter-catalogue";
    }
  }
  fs.writeFileSync(providersPath, JSON.stringify(providersFile, null, 2) + "\n");
  if (!JSON_OUT) console.log(`${C.bold}Applied ${applied} price correction(s) and restamped verified entries.${C.off}\n`);
}

const counts = rows.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
const failing = (counts.drift || 0) + (counts.gone || 0) + (counts.unenforceable || 0) + (counts.stale || 0);

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: failing === 0, checkedOn: today, counts, rows }, null, 2));
} else {
  console.log(`${C.bold}Pricing verification${C.off} ${C.dim}— ${rows.length} entries, catalogue of ${catalogue.size} models, ${today}${C.off}\n`);
  let lastProvider = null;
  for (const r of rows) {
    if (r.provider !== lastProvider) { console.log(`${C.bold}${r.provider}${C.off}`); lastProvider = r.provider; }
    console.log(`  ${ICON[r.status] || r.status}  ${C.dim}${r.model}${C.off}${r.note ? "\n      " + C.dim + r.note + C.off : ""}`);
  }
  console.log(`\n${C.bold}Summary${C.off}`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${String(v).padStart(3)}  ${k}`);
  if (failing) {
    console.log(`\n${C.yellow}${failing} entr${failing === 1 ? "y needs" : "ies need"} attention.${C.off}`);
    if (counts.drift) console.log(`${C.dim}Run with --write to apply first-party corrections automatically.${C.off}`);
    if (counts.unenforceable) console.log(`${C.dim}0/0 pricing means a budget cap on that provider can never trip.${C.off}`);
  } else {
    console.log(`\n${C.green}No drift detected.${C.off}`);
  }
}

// exitCode rather than exit(): the fetch keep-alive socket is still open, and
// tearing it down mid-flight trips a libuv assertion on Windows.
process.exitCode = failing ? 1 : 0;
