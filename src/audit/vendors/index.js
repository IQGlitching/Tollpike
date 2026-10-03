// Pulling vendor audit logs: scheduling, cursors, de-duplication, recording.
//
// A pull walks a connector's pages from its saved cursor, records each new
// record as a vendor.activity event, and saves the cursor after every page,
// so a crash or a vendor outage resends at most one page (which the seen-id
// window then drops). Every run that fetched something or failed is itself
// recorded (vendor.pull), and an idle connector leaves one a day, so the
// record shows the collection was running.

import { getSettings } from "../../storage/settings.js";
import { evaluate } from "../rules.js";
import { recordVendorEvent, auditEnabled } from "../index.js";
import { appendEvent } from "../log.js";
import { readState, writeState, isConfigured, credentialsPresent, rememberSeen } from "./framework.js";
import { CONNECTORS } from "./connectors.js";

const MAX_PAGES_PER_RUN = 50;
const IDLE_HEARTBEAT_MS = 24 * 60 * 60 * 1000;
const running = new Set();
const lastRuns = {};

function vendorSettings(id) {
  return getSettings().audit?.vendors?.[id] || {};
}

export function connectorCatalog() {
  return Object.values(CONNECTORS).map((c) => ({
    id: c.id,
    name: c.name,
    product: c.product,
    description: c.description,
    credentials: c.credentials.map(({ env, description, optional }) => ({ env, description, optional: Boolean(optional) })),
    settings: (c.settings || []).map(({ key, description, required }) => ({ key, description, required: Boolean(required) })),
    covers: c.covers,
    limits: c.limits
  }));
}

/**
 * Pull one connector now. Returns { ok, fetched, recorded, duplicates, pages }
 * or { ok:false, error }. Never throws.
 */
export async function pullVendor(id, { maxPages = MAX_PAGES_PER_RUN } = {}) {
  const connector = CONNECTORS[id];
  if (!connector) return { ok: false, error: `Unknown connector "${id}". Known: ${Object.keys(CONNECTORS).join(", ")}.` };
  const config = vendorSettings(id);
  if (!isConfigured(connector, config)) {
    const missing = [
      ...connector.credentials.filter((c) => !c.optional && !process.env[c.env]).map((c) => `env ${c.env}`),
      ...(connector.settings || []).filter((s) => s.required && !config[s.key]).map((s) => `setting audit.vendors.${id}.${s.key}`)
    ];
    return { ok: false, error: `${connector.name} is not configured: missing ${missing.join(", ")}.` };
  }
  if (running.has(id)) return { ok: false, error: `${connector.name} is already being pulled.` };
  running.add(id);

  const cfg = getSettings().audit || {};
  const ruleCtx = { modes: cfg.ruleModes || {}, disabled: cfg.disabledRules || [], allowedDomains: cfg.allowedDomains || [] };
  let state = readState()[id] || {};
  const counts = { fetched: 0, recorded: 0, duplicates: 0, pages: 0 };
  const startedAt = new Date().toISOString();
  let error = null;

  try {
    const seen = new Set(state.seen || []);
    for await (const page of connector.pages({ state, config })) {
      counts.pages += 1;
      const fresh = [];
      for (const r of page.records || []) {
        counts.fetched += 1;
        if (!r?.vendorId || seen.has(r.vendorId)) {
          counts.duplicates += 1;
          continue;
        }
        seen.add(r.vendorId);
        fresh.push(r.vendorId);
        if (!auditEnabled()) continue;
        const findings = [
          ...evaluate("vendor", `${r.action || ""} ${JSON.stringify(r.details || {})}`, ruleCtx),
          ...(r.content ? evaluate("prompt", r.content, ruleCtx) : [])
        ];
        recordVendorEvent({ ...r, vendor: id, product: r.product || connector.product }, findings);
        counts.recorded += 1;
      }
      state = { ...state, ...(page.cursor ? { cursor: page.cursor } : {}), seen: rememberSeen(state, fresh), lastPullAt: new Date().toISOString() };
      writeState(id, state);
      if (counts.pages >= maxPages) break;
    }
  } catch (err) {
    error = String(err?.message || err).slice(0, 300);
  } finally {
    running.delete(id);
  }

  const idleTooLong = Date.now() - Date.parse(state.lastRecordedRunAt || 0) > IDLE_HEARTBEAT_MS;
  if (counts.fetched || error || idleTooLong) {
    appendEvent({
      type: "vendor.pull",
      source: `vendor:${id}`,
      agent: null,
      vendor: id,
      startedAt,
      ...counts,
      outcome: error ? "failed" : "ok",
      error: error || undefined,
      ...(error ? { findings: [{ rule: "vendor.pull_failed", title: "Vendor audit log could not be collected", severity: "medium", mode: "flag", controls: ["ISO27001:8.15", "ISO27001:8.16", "SOC2:CC7.2", "ISO42001:A.10.3"], detail: error }], flagged: true, severity: "medium" } : {})
    });
    writeState(id, { ...state, lastRecordedRunAt: new Date().toISOString() });
  }
  lastRuns[id] = { at: new Date().toISOString(), ...counts, error };
  return error ? { ok: false, error, ...counts } : { ok: true, ...counts };
}

export function vendorsStatus() {
  const state = readState();
  return Object.values(CONNECTORS).map((c) => {
    const config = vendorSettings(c.id);
    return {
      id: c.id,
      name: c.name,
      product: c.product,
      enabled: config.enabled === true,
      configured: isConfigured(c, config),
      credentials: credentialsPresent(c),
      intervalMinutes: config.intervalMinutes || c.defaultIntervalMinutes,
      lastPullAt: state[c.id]?.lastPullAt || null,
      lastRun: lastRuns[c.id] || null
    };
  });
}

let timers = [];

/** Start the schedule for every enabled, configured connector. Idempotent. */
export function startVendorSchedule() {
  for (const t of timers) clearInterval(t);
  timers = [];
  for (const c of Object.values(CONNECTORS)) {
    const config = vendorSettings(c.id);
    if (config.enabled !== true || !isConfigured(c, config)) continue;
    const minutes = Math.min(Math.max(Number(config.intervalMinutes) || c.defaultIntervalMinutes, 5), 1440);
    const run = () => pullVendor(c.id).catch(() => {});
    setTimeout(run, 15_000).unref();
    timers.push(setInterval(run, minutes * 60 * 1000));
    timers.at(-1).unref();
  }
  return timers.length;
}
