// Pushing audit evidence to compliance platforms (Vanta, Drata).
//
// The other direction from the vendor connectors: those pull hosted agents'
// logs in, this sends Tollpike's evidence out to where a company runs its ISO
// 27001 and SOC 2 programme. Three things go:
//
//   tests     the continuous signals (signals.js): chain intact, agents
//             attributed, review backlog, egress enforced... each pass, fail
//             or not applicable, so the platform shows a live status
//   evidence  the evidence pack for the period (SUMMARY.md and the JSON),
//             uploaded to the evidence slot the operator mapped it to
//   accounts  the agent and sensor key register, so agent identities appear
//             in the platform's access reviews
//
// Only summaries leave: pass/fail with a one-line reason, the evidence pack
// (whose content is already redacted and hashed), and key names and dates.
// Never raw prompts, tool arguments or keys. Every push, successful or not,
// is recorded in the chain as grc.push, so the record shows what was sent
// where and when.
//
// Credentials live in the environment only, like the vendor connectors.

import { getSettings } from "../../storage/settings.js";
import { appendEvent } from "../log.js";
import { exportEvidence, evidenceMarkdown } from "../index.js";
import { listAgents } from "../agents.js";
import { computeSignals, SIGNAL_CATALOG } from "./signals.js";
import { PLATFORMS } from "./platforms.js";

const running = new Set();
const lastRuns = {};

function platformSettings(id) {
  return getSettings().audit?.grc?.[id] || {};
}

export function isConfigured(p, config = platformSettings(p.id)) {
  return p.credentials.filter((c) => !c.optional).every((c) => process.env[c.env]) && (p.settings || []).filter((s) => s.required).every((s) => config[s.key]);
}

export function grcCatalog() {
  return Object.values(PLATFORMS).map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    sends: p.sends,
    limits: p.limits,
    credentials: p.credentials.map(({ env, description, optional }) => ({ env, description, optional: Boolean(optional) })),
    settings: (p.settings || []).map(({ key, description, required }) => ({ key, description, required: Boolean(required) }))
  }));
}

/** Everything a platform may receive, built once per push. */
export function buildPayload({ periodDays = 30 } = {}) {
  const to = new Date();
  const from = new Date(to.getTime() - periodDays * 24 * 60 * 60 * 1000);
  const pack = exportEvidence({ from: from.toISOString(), to: to.toISOString() });
  const day = to.toISOString().slice(0, 10);
  return {
    generatedAt: to.toISOString(),
    period: { from: from.toISOString(), to: to.toISOString(), days: periodDays },
    signals: computeSignals({ windowDays: Math.min(periodDays, 7) }),
    evidence: {
      summary: { name: `tollpike-audit-evidence-${day}.md`, type: "text/markdown", content: evidenceMarkdown(pack) },
      json: { name: `tollpike-audit-evidence-${day}.json`, type: "application/json", content: JSON.stringify(pack, null, 2) },
      intact: pack.verification.intact,
      events: pack.events.length,
      head: pack.verification.head
    },
    accounts: listAgents({ includeRevoked: true }).map((a) => ({ id: a.id, name: a.name, kind: a.kind, active: a.active, createdAt: a.createdAt, revokedAt: a.revokedAt }))
  };
}

/** Push to one platform now. Never throws. */
export async function pushGrc(id) {
  const platform = PLATFORMS[id];
  if (!platform) return { ok: false, error: `Unknown platform "${id}". Known: ${Object.keys(PLATFORMS).join(", ")}.` };
  const config = platformSettings(id);
  if (!isConfigured(platform, config)) {
    const missing = [
      ...platform.credentials.filter((c) => !c.optional && !process.env[c.env]).map((c) => `env ${c.env}`),
      ...(platform.settings || []).filter((s) => s.required && !config[s.key]).map((s) => `setting audit.grc.${id}.${s.key}`)
    ];
    return { ok: false, error: `${platform.name} is not configured: missing ${missing.join(", ")}.` };
  }
  if (running.has(id)) return { ok: false, error: `${platform.name} push already running.` };
  running.add(id);
  const startedAt = new Date().toISOString();
  let outcome;
  try {
    const payload = buildPayload({ periodDays: Number(config.periodDays) || 30 });
    outcome = await platform.push({ payload, config });
  } catch (err) {
    outcome = { ok: false, error: String(err?.message || err).slice(0, 300) };
  } finally {
    running.delete(id);
  }
  const failed = !outcome?.ok;
  appendEvent({
    type: "grc.push",
    source: `grc:${id}`,
    agent: null,
    platform: id,
    startedAt,
    outcome: failed ? "failed" : "ok",
    tests: outcome?.tests,
    evidence: outcome?.evidence,
    accounts: outcome?.accounts,
    skipped: outcome?.skipped?.length ? outcome.skipped : undefined,
    error: failed ? outcome?.error : undefined,
    ...(failed
      ? { findings: [{ rule: "grc.push_failed", title: "Evidence could not be sent to the compliance platform", severity: "medium", mode: "flag", controls: ["ISO27001:5.28", "SOC2:CC2.1"], detail: outcome?.error || "failed" }], flagged: true, severity: "medium" }
      : {})
  });
  lastRuns[id] = { at: new Date().toISOString(), ...outcome };
  return outcome;
}

export function grcStatus() {
  return Object.values(PLATFORMS).map((p) => {
    const config = platformSettings(p.id);
    return {
      id: p.id,
      name: p.name,
      enabled: config.enabled === true,
      configured: isConfigured(p, config),
      credentials: Object.fromEntries(p.credentials.map((c) => [c.env, Boolean(process.env[c.env])])),
      intervalHours: Number(config.intervalHours) || p.defaultIntervalHours,
      lastRun: lastRuns[p.id] || null
    };
  });
}

let timers = [];
export function startGrcSchedule() {
  for (const t of timers) clearInterval(t);
  timers = [];
  for (const p of Object.values(PLATFORMS)) {
    const config = platformSettings(p.id);
    if (config.enabled !== true || !isConfigured(p, config)) continue;
    const hours = Math.min(Math.max(Number(config.intervalHours) || p.defaultIntervalHours, 1), 24 * 31);
    const run = () => pushGrc(p.id).catch(() => {});
    setTimeout(run, 60_000).unref();
    const t = setInterval(run, hours * 60 * 60 * 1000);
    t.unref();
    timers.push(t);
  }
  return timers.length;
}

export { SIGNAL_CATALOG, computeSignals };
