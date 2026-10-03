// Gemini in Google Workspace, through the Admin SDK Reports API.
//
// Two applications: gemini_in_workspace_apps (one event, feature_utilization,
// with the action, app and feature that used Gemini) and gemini_notebook
// (NotebookLM: chats, notebooks and sources). No prompt text is documented
// for either.
//
// Sources: developers.google.com workspace/admin/reports/reference/rest/v1/
// activities/list and the activity appendices for gemini-in-workspace-apps
// and gemini-notebook (checked 2026-10-03).

import { vendorFetch, envBaseUrl } from "../framework.js";
import { googleToken } from "../auth.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const APPS = ["gemini_in_workspace_apps", "gemini_notebook"];

function paramValue(p) {
  return p.value ?? p.intValue ?? p.boolValue ?? (p.multiValue ? p.multiValue.join(",") : undefined) ?? (p.multiIntValue ? p.multiIntValue.join(",") : undefined);
}

export const googleGemini = {
  id: "google-gemini",
  name: "Gemini in Google Workspace",
  product: "gemini",
  description: "Gemini and NotebookLM activity from the Admin SDK Reports API.",
  covers: "who used Gemini, in which app (Gmail, Docs, Sheets, Drive, Meet, the Gemini app, NotebookLM) and for what action; no prompt text",
  limits: "A service account with domain-wide delegation for admin.reports.audit.readonly, acting as a Workspace admin. Gemini logs exist from 2025-06-20 with 180 days of history.",
  credentials: [{ env: "GOOGLE_SERVICE_ACCOUNT_FILE", description: "Path to the service account's JSON key file" }],
  settings: [{ key: "adminEmail", description: "Workspace admin the service account acts as", required: true }],
  defaultIntervalMinutes: 60,

  async *pages({ state, config }) {
    const base = envBaseUrl(this.id, "https://admin.googleapis.com");
    const tokenUrl = envBaseUrl(`${this.id}-token`, "https://oauth2.googleapis.com") + "/token";
    const token = await googleToken({ keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_FILE, subject: config.adminEmail, scope: "https://www.googleapis.com/auth/admin.reports.audit.readonly", tokenUrl });
    const headers = { authorization: `Bearer ${token}` };
    const startTime = state.cursor || new Date(Date.now() - DAY_MS).toISOString();
    const endTime = new Date(Date.now() - 60_000).toISOString();
    if (startTime >= endTime) return;

    for (const app of APPS) {
      let pageToken = null;
      do {
        const qs = new URLSearchParams({ startTime, endTime, maxResults: "1000", ...(pageToken ? { pageToken } : {}) });
        const r = await vendorFetch(`${base}/admin/reports/v1/activity/users/all/applications/${app}?${qs}`, { headers });
        const records = [];
        for (const item of r.json?.items || []) {
          (item.events || []).forEach((ev, idx) => {
            const params = Object.fromEntries((ev.parameters || []).map((p) => [p.name, paramValue(p)]).filter(([, v]) => v !== undefined));
            records.push({
              vendorId: `${item.id?.time}|${item.id?.uniqueQualifier}|${idx}`,
              ts: item.id?.time,
              action: [app, ev.name, params.action].filter(Boolean).join(":"),
              actor: { id: item.actor?.profileId, email: item.actor?.email, type: item.actor?.callerType || (item.isAgenticAction ? "agent" : undefined) },
              ip: item.ipAddress,
              details: { type: ev.type, ...params, agentic: item.isAgenticAction || undefined }
            });
          });
        }
        pageToken = r.json?.nextPageToken || null;
        yield { records };
      } while (pageToken);
    }
    yield { records: [], cursor: endTime };
  }
};
