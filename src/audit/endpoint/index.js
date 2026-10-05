// Endpoint ingest: OS telemetry in, agent-relevant events out.
//
// Endpoint sensors produce far more than an audit trail should hold, so
// almost nothing is kept verbatim. What reaches the hash-chained log:
//
//   endpoint.process  every process in an agent's tree (except the runtime's
//                     own helpers), with the audited action that explains it,
//                     or flagged as unexplained
//   endpoint.file     file activity in an agent's tree that a rule flags
//                     (credentials, keys, system account files)
//   endpoint.network  a connection or DNS lookup to a model provider from
//                     anywhere but the gateway (traffic that went around the
//                     audit), or a flagged domain from an agent's tree
//   endpoint.sensor   a heartbeat per sensor, at most hourly, with counts, so
//                     the record shows monitoring was running
//
// Everything else is counted and dropped: Tollpike is not an EDR, and an
// audit log that holds every process on every machine would bury the events
// that matter.

import os from "node:os";
import { getSettings } from "../../storage/settings.js";
import { parseEndpoint } from "./parsers.js";
import { ProcessTables, findExplanation } from "./correlate.js";
import { evaluate } from "../rules.js";
import { recordEndpointEvent, recentActions, auditEnabled, originOf } from "../index.js";
import { currentContext } from "../context.js";
import { appendEvent, readEvents } from "../log.js";
import { providerHosts } from "../egress.js";

const HEARTBEAT_MS = 60 * 60 * 1000;

let tables = null;
let tablesKey = null;
function processTables() {
  const custom = getSettings().audit?.agentProcesses || [];
  const key = JSON.stringify(custom);
  if (!tables || key !== tablesKey) {
    tables = new ProcessTables({ runtimes: custom });
    tablesKey = key;
  }
  return tables;
}

let providers = null;
function providerSet() {
  if (!providers) providers = providerHosts().map((p) => p.host);
  return providers;
}

function providerOf(host) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  if (!h) return null;
  return providerSet().find((p) => h === p || h.endsWith(`.${p}`)) || null;
}

// The gateway itself talks to providers; that is the one place it should.
function isGatewayHost(host) {
  const h = String(host || "").toLowerCase();
  const allowed = [os.hostname().toLowerCase(), ...(getSettings().audit?.gatewayHosts || []).map((x) => String(x).toLowerCase())];
  return allowed.some((a) => h === a || h.split(".")[0] === a.split(".")[0]);
}

const heartbeats = new Map(); // sensor|host|format -> { since, last, counts }
const networkSeen = new Map(); // host|image|destination -> last recorded at

function basenameOf(p) {
  return String(p || "").split(/[\\/]/).pop().toLowerCase();
}

function heartbeat(key, info, counts) {
  const now = Date.now();
  const hb = heartbeats.get(key) || { since: new Date(now).toISOString(), last: 0, counts: { received: 0, recorded: 0, ignored: 0, skipped: 0, orphaned: 0 } };
  for (const k of Object.keys(hb.counts)) hb.counts[k] += counts[k] || 0;
  if (now - hb.last >= HEARTBEAT_MS) {
    appendEvent({ type: "endpoint.sensor", source: `endpoint:${info.format}`, agent: null, sensor: info.sensor, host: info.host || undefined, since: hb.since, ...hb.counts });
    hb.last = now;
    hb.since = new Date(now).toISOString();
    hb.counts = { received: 0, recorded: 0, ignored: 0, skipped: 0, orphaned: 0 };
  }
  heartbeats.set(key, hb);
}

/**
 * Ingest one batch. Returns counts the sensor can log:
 * { ok, received, recorded, unexplained, ignored, skipped }.
 */
export function ingestEndpoint({ format, body, host, sensor = "anonymous" }) {
  const parsed = parseEndpoint(format, body, { host });
  if (parsed.error) return { ok: false, error: parsed.error };
  if (!auditEnabled()) return { ok: true, received: parsed.events.length, recorded: 0, note: "auditing is off" };

  const t = processTables();
  const origin = originOf(currentContext()?.ip);
  const actions = recentActions().filter((a) => !a.origin || a.origin === origin);
  const cfg = getSettings().audit || {};
  const ruleCtx = { modes: cfg.ruleModes || {}, disabled: cfg.disabledRules || [], allowedDomains: cfg.allowedDomains || [] };
  const counts = { received: parsed.events.length, recorded: 0, unexplained: 0, ignored: 0, orphaned: 0, skipped: parsed.skipped };
  const source = `endpoint:${format}`;

  // Process creation first, in time order, so a child's parent is in the
  // table before the child is classified even when a batch arrives unsorted.
  const events = [...parsed.events].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  for (const e of events) {
    if (e.kind === "snapshot") {
      t.upsert(e);
      continue;
    }

    if (e.kind === "process") {
      const entry = t.upsert(e);
      const where = t.classify(e.host, entry);
      if (!where.runtime || where.isRoot) {
        if (where.isRoot) {
          recordEndpointEvent({ type: "endpoint.process", source, sensor, host: e.host, pid: e.pid, ppid: e.ppid, image: e.image, commandLine: e.commandLine, user: e.user, cwd: e.cwd, agentRuntime: where.runtime, runtimeStart: true }, []);
          counts.recorded += 1;
        } else {
          counts.ignored += 1;
          // A parent the table has never seen: the process may belong to an
          // agent, but its ancestry cannot be traced. Usually a snapshot taken
          // after an intermediate process exited; a live event stream records
          // each process as it starts and does not lose them. Counted so the
          // coverage gap is visible.
          if (entry && entry.ppid != null && entry.ppid !== 0 && !t.get(e.host, entry.ppid)) counts.orphaned += 1;
        }
        continue;
      }
      if (where.helper) {
        counts.ignored += 1;
        continue;
      }
      const explained = where.inherited || findExplanation(entry, actions);
      if (explained) entry.explainedBy = explained;
      const findings = [...evaluate("tool_call", e.commandLine || e.image || "", ruleCtx), ...evaluate("endpoint", "", { ...ruleCtx, unexplained: !explained })];
      recordEndpointEvent(
        {
          type: "endpoint.process",
          source,
          sensor,
          host: e.host,
          pid: e.pid,
          ppid: e.ppid,
          image: e.image,
          commandLine: e.commandLine,
          user: e.user,
          cwd: e.cwd,
          agentRuntime: where.runtime,
          agentRootPid: where.root.pid,
          agent: explained?.agent || null,
          explainedBy: explained ? { eventId: explained.eventId, type: explained.type, toolUseId: explained.toolUseId || undefined, inherited: Boolean(where.inherited) || undefined } : null
        },
        findings
      );
      counts.recorded += 1;
      if (!explained) counts.unexplained += 1;
      continue;
    }

    const entry = Number.isFinite(e.pid) ? t.get(e.host, e.pid) : null;
    const where = entry ? t.classify(e.host, entry) : { runtime: null };
    const inTree = Boolean(where.runtime);

    if (e.kind === "file") {
      if (!inTree) {
        counts.ignored += 1;
        continue;
      }
      const findings = evaluate("tool_call", e.path || "", ruleCtx).filter((f) => f.rule === "path.sensitive" || f.rule === "secret.exposure");
      if (!findings.length) {
        counts.ignored += 1;
        continue;
      }
      recordEndpointEvent({ type: "endpoint.file", source, sensor, host: e.host, pid: e.pid, image: e.image || entry?.image, path: e.path, action: e.action, agentRuntime: where.runtime, agentRootPid: where.root?.pid }, findings);
      counts.recorded += 1;
      continue;
    }

    if (e.kind === "network" || e.kind === "dns") {
      const target = e.kind === "dns" ? e.query : e.destHost || e.destIp;
      const provider = providerOf(target);
      const bypass = provider && !(isGatewayHost(e.host) && (!entry || !inTree));
      const findings = [
        ...(bypass ? evaluate("endpoint", "", { ...ruleCtx, providerHost: provider }) : []),
        ...(inTree && target ? evaluate("tool_call", `https://${target}/`, ruleCtx).filter((f) => f.rule === "network.unlisted_domain") : [])
      ];
      if (!findings.length) {
        counts.ignored += 1;
        continue;
      }
      // One record per host, program and destination per hour. A client
      // that holds a provider connection open reconnects constantly, and the
      // fact worth recording is that it talks to the provider at all.
      const seenKey = `${e.host}|${basenameOf(e.image || entry?.image)}|${provider || target}`;
      const lastSeen = networkSeen.get(seenKey);
      if (lastSeen && Date.now() - lastSeen < HEARTBEAT_MS) {
        counts.ignored += 1;
        continue;
      }
      networkSeen.set(seenKey, Date.now());
      if (networkSeen.size > 10_000) networkSeen.delete(networkSeen.keys().next().value);
      recordEndpointEvent({ type: "endpoint.network", source, sensor, host: e.host, pid: e.pid, image: e.image || entry?.image, destHost: e.destHost || (e.kind === "dns" ? e.query : undefined), destIp: e.destIp, destPort: e.destPort, dns: e.kind === "dns" || undefined, agentRuntime: where.runtime || undefined }, findings);
      counts.recorded += 1;
      continue;
    }
    counts.ignored += 1;
  }

  const hostLabel = events.find((e) => e.host)?.host || host || null;
  heartbeat(`${sensor}|${hostLabel}|${format}`, { format, sensor, host: hostLabel }, counts);
  return { ok: true, ...counts };
}

// Sensors are known from two places: batches this process has received (in
// memory, with counts not yet written to a heartbeat), and heartbeats on the
// record from the last two days. The record is what survives a gateway
// restart, so a sensor that reported yesterday is not shown as absent today.
const SENSOR_WINDOW_MS = 48 * 60 * 60 * 1000;

export function endpointStatus() {
  const sensors = new Map();
  const cutoff = Date.now() - SENSOR_WINDOW_MS;
  for (const e of readEvents()) {
    if (e.type !== "endpoint.sensor" || Date.parse(e.ts) < cutoff) continue;
    const format = String(e.source || "").replace(/^endpoint:/, "");
    sensors.set(`${e.sensor}|${e.host || null}|${format}`, { sensor: e.sensor, host: e.host || null, format, since: e.since, lastHeartbeatAt: e.ts, pending: null });
  }
  for (const [key, hb] of heartbeats) {
    const [sensor, host, format] = key.split("|");
    const prev = sensors.get(key) || {};
    sensors.set(key, { sensor, host: host === "null" ? null : host, format, since: prev.since || hb.since, lastHeartbeatAt: prev.lastHeartbeatAt || null, pending: hb.counts });
  }
  return { hosts: tables ? tables.stats() : {}, sensors: [...sensors.values()] };
}

/** Tests only. */
export function _resetEndpoint() {
  tables = null;
  tablesKey = null;
  providers = null;
  heartbeats.clear();
  networkSeen.clear();
}
