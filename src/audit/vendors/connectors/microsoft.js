// Microsoft 365 Copilot.
//
// Two connectors, because Microsoft splits the record in two:
//
//   microsoft-copilot      Office 365 Management Activity API, Audit.General.
//                          Every Copilot interaction across Word, Excel,
//                          Teams, Outlook, BizChat and the rest, tenant-wide:
//                          who, which app, which files were accessed, their
//                          sensitivity labels, which model. No prompt text.
//   microsoft-copilot-chat Microsoft Graph getAllEnterpriseInteractions.
//                          The prompts and responses themselves, per user.
//                          Scanned for credentials and personal data, then
//                          dropped: only a hash and length are kept.
//
// Sources: learn.microsoft.com office-365-management-activity-api-reference,
// copilot-schema, and the aiInteractionHistory getAllEnterpriseInteractions
// reference (all checked 2026-10-03).

import { vendorFetch, envBaseUrl } from "../framework.js";
import { microsoftToken } from "../auth.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// RecordType 261 CopilotInteraction, 284 AIAppInteraction, 310-319 Copilot
// plugin and workspace changes. Workload "Copilot" catches any newer types.
const COPILOT_RECORD_TYPES = new Set([261, 284, 310, 311, 312, 313, 314, 315, 316, 317, 318, 319]);

function msTime(d) {
  return new Date(d).toISOString().slice(0, 19); // YYYY-MM-DDTHH:MM:SS, UTC
}

const CREDS = [
  { env: "MS365_CLIENT_ID", description: "Entra app (client) id with Office 365 Management APIs: ActivityFeed.Read (application)" },
  { env: "MS365_CLIENT_SECRET", description: "That app's client secret" }
];

export const microsoftCopilot = {
  id: "microsoft-copilot",
  name: "Microsoft 365 Copilot (activity)",
  product: "microsoft-365-copilot",
  description: "Copilot interaction records from the Office 365 Management Activity API (Audit.General).",
  covers: "every Copilot interaction tenant-wide: user, app, accessed files and their sensitivity labels, model; no prompt text",
  limits: "Unified audit logging must be on. A new subscription can take up to 12 hours to produce content. Content older than 7 days cannot be fetched, so the gateway must pull at least weekly.",
  credentials: CREDS,
  settings: [
    { key: "tenantId", description: "Entra tenant id (GUID)", required: true },
    { key: "publisherIdentifier", description: "Your tenant GUID, sent for a dedicated throttling quota (optional)" }
  ],
  defaultIntervalMinutes: 30,

  async *pages({ state, config }) {
    const base = envBaseUrl(this.id, "https://manage.office.com");
    const loginBase = envBaseUrl(`${this.id}-login`, "https://login.microsoftonline.com");
    const root = `${base}/api/v1.0/${encodeURIComponent(config.tenantId)}/activity/feed`;
    const token = await microsoftToken({ tenantId: config.tenantId, clientId: process.env.MS365_CLIENT_ID, clientSecret: process.env.MS365_CLIENT_SECRET, resource: "https://manage.office.com", loginBase });
    const headers = { authorization: `Bearer ${token}` };
    const pub = config.publisherIdentifier ? `&PublisherIdentifier=${encodeURIComponent(config.publisherIdentifier)}` : "";

    // Ensure the Audit.General subscription exists. Starting one that is
    // already enabled is answered with an error saying so, which is fine.
    if (!state.subscribed) {
      try {
        await vendorFetch(`${root}/subscriptions/start?contentType=Audit.General${pub}`, { method: "POST", headers, retries: 1 });
      } catch (err) {
        if (!/already enabled|AF20024/i.test(err.message)) throw err;
      }
      state.subscribed = true;
    }

    // Windows of at most 24 hours, no further back than 7 days, from the cursor to now.
    const now = Date.now();
    let from = Math.max(state.cursor ? Date.parse(state.cursor) : now - DAY_MS, now - 7 * DAY_MS + 60_000);
    while (from < now - 60_000) {
      const to = Math.min(from + DAY_MS, now);
      let next = `${root}/subscriptions/content?contentType=Audit.General&startTime=${msTime(from)}&endTime=${msTime(to)}${pub}`;
      const records = [];
      while (next) {
        const list = await vendorFetch(next, { headers });
        for (const blob of Array.isArray(list.json) ? list.json : []) {
          const content = await vendorFetch(blob.contentUri, { headers });
          for (const r of Array.isArray(content.json) ? content.json : []) {
            if (r.Workload !== "Copilot" && !COPILOT_RECORD_TYPES.has(Number(r.RecordType))) continue;
            records.push(normaliseActivity(r));
          }
        }
        next = list.headers.get("nextpageuri") || null;
      }
      yield { records, cursor: new Date(to).toISOString() };
      from = to;
    }
  }
};

function normaliseActivity(r) {
  const d = r.CopilotEventData || {};
  const messages = Array.isArray(d.Messages) ? d.Messages : [];
  const resources = Array.isArray(d.AccessedResources) ? d.AccessedResources : [];
  const model = Array.isArray(d.ModelTransparencyDetails) ? d.ModelTransparencyDetails[0] : d.ModelTransparencyDetails;
  return {
    vendorId: r.Id,
    ts: r.CreationTime ? new Date(`${r.CreationTime}${/Z|[+-]\d\d:?\d\d$/.test(r.CreationTime) ? "" : "Z"}`).toISOString() : undefined,
    action: [r.Operation, d.AppHost].filter(Boolean).join(":"),
    actor: { id: r.UserId, type: r.UserType === 0 ? "user" : r.UserType !== undefined ? `type-${r.UserType}` : undefined },
    ip: r.ClientIP,
    target: d.Contexts?.[0]?.Id,
    details: {
      recordType: r.RecordType,
      appHost: d.AppHost,
      threadId: d.ThreadId,
      prompts: messages.filter((m) => m.isPrompt).length,
      responses: messages.filter((m) => m.isPrompt === false).length,
      accessedResources: resources.length || undefined,
      sensitivityLabels: [...new Set(resources.map((x) => x.SensitivityLabelId).filter(Boolean))].slice(0, 20),
      resourceActions: [...new Set(resources.map((x) => x.Action).filter(Boolean))].slice(0, 10),
      plugins: (d.AISystemPlugin || []).map((p) => p.Name || p.Id).filter(Boolean).slice(0, 10),
      model: model ? [model.ModelProviderName, model.ModelName, model.ModelVersion].filter(Boolean).join(" ") || undefined : undefined,
      region: r.ClientRegion
    }
  };
}

export const microsoftCopilotChat = {
  id: "microsoft-copilot-chat",
  name: "Microsoft 365 Copilot (prompts and responses)",
  product: "microsoft-365-copilot",
  description: "Copilot prompts and responses from Microsoft Graph getAllEnterpriseInteractions, scanned for credentials and personal data, then kept only as hashes.",
  covers: "the text of each Copilot prompt and response, checked by the prompt rules (credentials, personal data); stored as a hash and length only",
  limits: "Per user: the connector lists the tenant's users (User.Read.All) and asks for each. Needs AiEnterpriseInteraction.Read.All (application) and Copilot-licensed users. Copilot Studio agents are not included. Paging by @odata.nextLink is assumed (standard Graph behaviour; not stated on the method page).",
  credentials: [
    { env: "MS365_CLIENT_ID", description: "Entra app (client) id with Graph AiEnterpriseInteraction.Read.All and User.Read.All (application)" },
    { env: "MS365_CLIENT_SECRET", description: "That app's client secret" }
  ],
  settings: [{ key: "tenantId", description: "Entra tenant id (GUID)", required: true }],
  defaultIntervalMinutes: 60,

  async *pages({ state, config }) {
    const graph = envBaseUrl(this.id, "https://graph.microsoft.com");
    const loginBase = envBaseUrl(`${this.id}-login`, "https://login.microsoftonline.com");
    const token = await microsoftToken({ tenantId: config.tenantId, clientId: process.env.MS365_CLIENT_ID, clientSecret: process.env.MS365_CLIENT_SECRET, scope: "https://graph.microsoft.com/.default", loginBase });
    const headers = { authorization: `Bearer ${token}` };
    const to = new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, "Z");
    const from = (state.cursor || new Date(Date.now() - DAY_MS).toISOString()).replace(/\.\d+Z$/, "Z");
    if (Date.parse(from) >= Date.parse(to)) return;

    const users = [];
    for (let next = `${graph}/v1.0/users?$select=id,userPrincipalName&$top=999`; next; ) {
      const r = await vendorFetch(next, { headers });
      users.push(...(r.json?.value || []));
      next = r.json?.["@odata.nextLink"] || null;
    }

    for (const user of users) {
      const records = [];
      const filter = encodeURIComponent(`createdDateTime gt ${from} and createdDateTime lt ${to}`);
      for (let next = `${graph}/v1.0/copilot/users/${encodeURIComponent(user.id)}/interactionHistory/getAllEnterpriseInteractions?$top=100&$filter=${filter}`; next; ) {
        let r;
        try {
          r = await vendorFetch(next, { headers });
        } catch (err) {
          // Users without a Copilot license have no history; that is not a failed pull.
          if (err.status === 404 || err.status === 403) break;
          throw err;
        }
        for (const i of r.json?.value || []) records.push(normaliseInteraction(i, user));
        next = r.json?.["@odata.nextLink"] || null;
      }
      if (records.length) yield { records };
    }
    yield { records: [], cursor: to };
  }
};

function normaliseInteraction(i, user) {
  const text = i.body?.content ? String(i.body.content).replace(/<[^>]+>/g, " ") : "";
  return {
    vendorId: i.id,
    ts: i.createdDateTime,
    action: `${i.interactionType || "interaction"}:${i.appClass || "copilot"}`,
    actor: { id: i.from?.user?.id || user.id, email: user.userPrincipalName, type: i.from?.application ? "application" : "user" },
    content: text,
    details: {
      sessionId: i.sessionId,
      requestId: i.requestId,
      conversationType: i.conversationType,
      contexts: (i.contexts || []).map((c) => c.contextType).filter(Boolean).slice(0, 10),
      attachments: (i.attachments || []).length || undefined,
      links: (i.links || []).length || undefined
    }
  };
}
