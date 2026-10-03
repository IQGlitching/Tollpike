// Continuous compliance tests, computed from the audit record.
//
// A compliance platform (Vanta, Drata) shows a test as passing or failing on
// its dashboard. These are the tests Tollpike can answer from its own
// record, each mapped to the controls it evidences:
//
//   audit.chain_intact      the hash chain verifies, nothing edited or deleted
//   audit.chain_keyed       the chain is keyed (tamper-evident, not just
//                           damage-evident)
//   audit.agents_attributed every model call in the window carried an agent key
//   audit.review_backlog    no flagged event has waited longer than the
//                           allowed number of days for a person's sign-off
//   audit.preexecution      Claude Code hooks or the MCP proxy reported in the
//                           window, so actions can be checked before they run
//   audit.egress_enforced   endpoint sensors saw no model-provider connection
//                           that bypassed the gateway
//   audit.vendor_collection every enabled vendor log connector is collecting
//
// A test that has nothing to judge (no sensors, no vendors enabled) reports
// "not_applicable" rather than passing: a green light with no data behind it
// is exactly what an auditor would call misleading.

import { readEvents, verifyAudit } from "../log.js";
import { reviewQueue, auditEnabled } from "../index.js";
import { hasAgentKeys } from "../agents.js";
import { getSettings } from "../../storage/settings.js";

const DAY = 24 * 60 * 60 * 1000;

export const SIGNAL_CATALOG = [
  { id: "audit.chain_intact", title: "AI agent audit log is intact", controls: ["ISO27001:8.15", "ISO27001:5.28", "SOC2:CC7.2", "ISO42001:A.6.2.8", "EUAIA:Art.12", "EUAIA:Art.19", "EUAIA:Art.26(6)", "NISTAIRMF:MEASURE 2.8"] },
  { id: "audit.chain_keyed", title: "AI agent audit log is tamper-evident (keyed)", controls: ["ISO27001:8.15", "SOC2:CC7.2", "ISO42001:A.6.2.8", "EUAIA:Art.12", "NISTAIRMF:MEASURE 2.8"] },
  { id: "audit.agents_attributed", title: "Every AI model call is attributed to an agent identity", controls: ["ISO27001:5.16", "ISO27001:8.15", "SOC2:CC6.1", "ISO42001:A.6.2.8", "ISO42001:A.3.2", "EUAIA:Art.12", "NISTAIRMF:MEASURE 2.8"] },
  { id: "audit.review_backlog", title: "Flagged AI agent events are reviewed on time", controls: ["ISO27001:5.25", "SOC2:CC7.3", "SOC2:CC7.4", "ISO42001:A.6.2.6", "EUAIA:Art.14", "EUAIA:Art.26(2)", "NISTAIRMF:MANAGE 4.3", "NISTAIRMF:MAP 3.5"] },
  { id: "audit.preexecution", title: "AI agent actions are checked before they run", controls: ["ISO27001:8.16", "ISO27001:8.18", "SOC2:CC6.8", "ISO42001:A.9.2", "ISO42001:A.9.4", "EUAIA:Art.14", "NISTAIRMF:MANAGE 2.4", "NISTAIRMF:MAP 3.5"] },
  { id: "audit.egress_enforced", title: "No AI provider access bypasses the gateway", controls: ["ISO27001:8.20", "ISO27001:5.23", "SOC2:CC6.6", "ISO42001:A.9.4", "ISO42001:A.10.3", "EUAIA:Art.12", "EUAIA:Art.26(5)", "NISTAIRMF:GOVERN 1.6", "NISTAIRMF:MEASURE 2.8"] },
  { id: "audit.vendor_collection", title: "Hosted AI service audit logs are collected", controls: ["ISO27001:5.23", "ISO27001:8.15", "SOC2:CC7.2", "ISO42001:A.10.3", "ISO42001:A.6.2.8", "EUAIA:Art.26(5)", "EUAIA:Art.12", "NISTAIRMF:MANAGE 3.1", "NISTAIRMF:GOVERN 6.1"] }
];

function result(id, status, detail, metrics = {}) {
  const meta = SIGNAL_CATALOG.find((s) => s.id === id);
  return { id, title: meta.title, status, detail, controls: meta.controls, metrics, measuredAt: new Date().toISOString() };
}

/**
 * Evaluate every signal. `windowDays` bounds the activity tests;
 * `reviewDays` is the longest a flag may wait for sign-off.
 */
export function computeSignals({ windowDays = 7, reviewDays = getSettings().audit?.grcReviewDays ?? 7 } = {}) {
  const now = Date.now();
  const since = now - windowDays * DAY;
  const events = readEvents();
  const inWindow = events.filter((e) => Date.parse(e.ts) >= since);
  const v = verifyAudit();
  const out = [];

  out.push(
    !auditEnabled()
      ? result("audit.chain_intact", "fail", "Auditing is switched off.", { rows: v.total })
      : v.total === 0
        ? result("audit.chain_intact", "not_applicable", "The audit log has no rows yet.", { rows: 0 })
        : result("audit.chain_intact", v.intact ? "pass" : "fail",
            v.intact ? `${v.total} rows verify; the anchor agrees.` : `${v.brokenLinks} broken link(s)${v.truncated ? ", rows deleted" : ""}${v.rolledBack ? ", tail replaced" : ""}${v.anchorOk === false ? ", anchor fails" : ""}.`,
            { rows: v.total, brokenLinks: v.brokenLinks })
  );

  out.push(result("audit.chain_keyed", v.keyed ? "pass" : "fail", v.keyed ? "HMAC-SHA256 keyed with a secret held outside the data directory." : "TOLLPIKE_SECRET is not set: the chain detects damage but a local editor could rewrite it."));

  const calls = inWindow.filter((e) => e.type === "model.call");
  const anonymous = calls.filter((e) => !e.agent).length;
  out.push(
    !calls.length
      ? result("audit.agents_attributed", "not_applicable", `No model calls in the last ${windowDays} days.`, { calls: 0 })
      : result("audit.agents_attributed", anonymous === 0 && hasAgentKeys() ? "pass" : "fail",
          anonymous === 0 ? `${calls.length} model calls, all attributed.` : `${anonymous} of ${calls.length} model calls carried no agent identity.`,
          { calls: calls.length, unattributed: anonymous })
  );

  const overdueCutoff = now - reviewDays * DAY;
  const queue = reviewQueue(events);
  const overdue = queue.filter((e) => Date.parse(e.ts) < overdueCutoff);
  out.push(result("audit.review_backlog", overdue.length ? "fail" : "pass",
    overdue.length ? `${overdue.length} flagged event(s) unreviewed for more than ${reviewDays} days (${queue.length} open in total).` : `${queue.length} open, none older than ${reviewDays} days.`,
    { open: queue.length, overdue: overdue.length, allowedDays: reviewDays }));

  const pre = inWindow.filter((e) => (e.source === "claude-code" || e.source === "mcp-proxy") && (e.type === "tool.requested" || e.type === "tool.executed")).length;
  out.push(result("audit.preexecution", pre ? "pass" : "fail",
    pre ? `${pre} pre-execution events from Claude Code hooks or the MCP proxy in ${windowDays} days.` : `No Claude Code hook or MCP proxy events in ${windowDays} days: actions are recorded only as the model reported them.`,
    { events: pre }));

  const heartbeats = inWindow.filter((e) => e.type === "endpoint.sensor").length;
  const bypass = inWindow.filter((e) => (e.findings || []).some((f) => f.rule === "endpoint.direct_provider_access")).length;
  out.push(
    !heartbeats && !bypass
      ? result("audit.egress_enforced", "not_applicable", `No endpoint sensor reported in ${windowDays} days, so bypass cannot be measured.`, { sensorsReporting: 0 })
      : result("audit.egress_enforced", bypass ? "fail" : "pass",
          bypass ? `${bypass} model-provider connection(s) bypassed the gateway in ${windowDays} days.` : `Endpoint sensors reported; no gateway bypass seen in ${windowDays} days.`,
          { bypassEvents: bypass, heartbeats })
  );

  const vendors = getSettings().audit?.vendors || {};
  const enabled = Object.entries(vendors).filter(([, c]) => c?.enabled).map(([id]) => id);
  if (!enabled.length) {
    out.push(result("audit.vendor_collection", "not_applicable", "No vendor audit-log connector is enabled.", { enabled: 0 }));
  } else {
    const pulls = events.filter((e) => e.type === "vendor.pull" && Date.parse(e.ts) >= now - 2 * DAY);
    const failing = enabled.filter((id) => {
      const last = pulls.filter((p) => p.vendor === id).at(-1);
      return !last || last.outcome === "failed";
    });
    out.push(result("audit.vendor_collection", failing.length ? "fail" : "pass",
      failing.length ? `No successful pull in 48 hours for: ${failing.join(", ")}.` : `${enabled.length} connector(s) collecting.`,
      { enabled: enabled.length, failing: failing.length }));
  }

  return out;
}
