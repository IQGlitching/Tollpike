// Cursor, through the team Admin API audit log.
//
// Logins, membership, API keys, settings, MCP and hook configuration, cloud
// agents. Cursor's audit log never contains prompts, agent output or code;
// for those, point Cursor at this gateway as its model endpoint.
//
// Source: cursor.com/docs/account/teams/admin-api (checked 2026-10-03).

import { vendorFetch, envBaseUrl } from "../framework.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 30 * DAY_MS;

export const cursorAudit = {
  id: "cursor",
  name: "Cursor (team audit log)",
  product: "cursor",
  description: "Team audit events from the Cursor Admin API.",
  covers: "logins, membership, API keys, settings, MCP and hook configuration, cloud agents; no prompts, output or code",
  limits: "Enterprise plan. An Admin API key from cursor.com/dashboard. 20 requests per minute; windows of at most 30 days.",
  credentials: [{ env: "CURSOR_ADMIN_API_KEY", description: "Cursor Admin API key" }],
  settings: [],
  defaultIntervalMinutes: 30,

  async *pages({ state }) {
    const base = envBaseUrl(this.id, "https://api.cursor.com");
    const auth = `Basic ${Buffer.from(`${process.env.CURSOR_ADMIN_API_KEY}:`).toString("base64")}`;
    const end = Date.now();
    const start = Math.max(state.cursor ? Date.parse(state.cursor) : end - DAY_MS, end - MAX_WINDOW_MS + 60_000);
    let newest = new Date(start).toISOString();
    for (let page = 1; ; page++) {
      const qs = new URLSearchParams({ startTime: String(start), endTime: String(end), page: String(page), pageSize: "500" });
      const r = await vendorFetch(`${base}/teams/audit-logs?${qs}`, { headers: { authorization: auth } });
      const records = (r.json?.events || []).map((e) => {
        if (e.timestamp > newest) newest = e.timestamp;
        return {
          vendorId: e.event_id,
          ts: e.timestamp,
          action: e.event_type,
          actor: { email: e.user_email, type: "user" },
          ip: e.ip_address,
          details: { application: e.application_type, ...(e.event_data && typeof e.event_data === "object" ? e.event_data : {}) }
        };
      });
      const more = r.json?.pagination?.hasNextPage === true;
      yield { records, cursor: more ? undefined : newest };
      if (!more) return;
    }
  }
};
