// OpenAI: the API platform's audit log, and ChatGPT Enterprise's compliance
// logs.
//
//   openai-platform  GET /v1/organization/audit_logs with an Admin key.
//                    Logins, API keys, projects, members, roles, SSO and
//                    SCIM, IP allowlists, service accounts. Audit logging
//                    must be switched on in the organization first.
//   chatgpt-enterprise  The Compliance Logs Platform. ChatGPT conversations,
//                    audit and auth events arrive as immutable JSONL files of
//                    about ten minutes each; this lists the files after the
//                    cursor, downloads each, checks its published SHA-256,
//                    and records every line. Message text is scanned and then
//                    dropped. Files are kept for 30 days, so pull at least
//                    weekly.
//
// Sources: the OpenAI OpenAPI spec (path /organization/audit_logs), help
// article 9687866, chatgpt.com/public/admin/api-reference and its
// openapi.json, and the Compliance Logs Platform cookbook (checked 2026-10-03).

import crypto from "node:crypto";
import { vendorFetch, envBaseUrl } from "../framework.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const openaiPlatform = {
  id: "openai-platform",
  name: "OpenAI API platform (audit log)",
  product: "openai-api",
  description: "Organization audit log from the OpenAI Admin API.",
  covers: "logins, API keys, projects, members and roles, SSO and SCIM, IP allowlists, service accounts, organization settings; no prompts",
  limits: "An organization Admin key with Audit Logs: Read, created by an owner. Audit logging must be enabled in the organization's data controls (and cannot be turned off again). OpenAI keeps the log best-effort with no fixed retention, so this copy is the durable one.",
  credentials: [{ env: "OPENAI_ADMIN_KEY", description: "OpenAI organization Admin key with Audit Logs: Read" }],
  settings: [{ key: "includeTenant", description: 'Set to "true" to also pull tenant-scoped events (SSO connections, tenant roles, policies)' }],
  defaultIntervalMinutes: 15,

  async *pages({ state, config }) {
    const base = envBaseUrl(this.id, "https://api.openai.com");
    const headers = { authorization: `Bearer ${process.env.OPENAI_ADMIN_KEY}` };
    const since = state.cursor ? Number(state.cursor) : Math.floor((Date.now() - DAY_MS) / 1000);
    let newest = since;
    for (const tenantOnly of config.includeTenant === "true" ? [false, true] : [false]) {
      let after = null;
      for (;;) {
        const qs = new URLSearchParams({ "effective_at[gte]": String(since), limit: "100", ...(after ? { after } : {}), ...(tenantOnly ? { tenant_only: "true" } : {}) });
        const r = await vendorFetch(`${base}/v1/organization/audit_logs?${qs}`, { headers });
        const rows = r.json?.data || [];
        const records = rows.map((e) => {
          if (e.effective_at > newest) newest = e.effective_at;
          const session = e.actor?.session;
          const key = e.actor?.api_key;
          return {
            vendorId: e.id,
            ts: new Date(e.effective_at * 1000).toISOString(),
            action: e.type,
            actor: session
              ? { id: session.user?.id, email: session.user?.email, type: "user" }
              : key
                ? { id: key.id, email: key.user?.email, type: key.type === "service_account" ? "service_account" : "api_key" }
                : undefined,
            ip: session?.ip_address,
            target: e.project?.name || e.project?.id,
            details: { project: e.project?.id, tenant: tenantOnly || undefined, ...(e[e.type] && typeof e[e.type] === "object" ? e[e.type] : {}) }
          };
        });
        yield { records };
        if (!r.json?.has_more || !r.json?.last_id) break;
        after = r.json.last_id;
      }
    }
    // >= on the next pull re-reads the newest second; the seen-id window drops the repeats.
    yield { records: [], cursor: String(newest) };
  }
};

const DEFAULT_CHATGPT_TYPES = "AUDIT_LOG,AUTH_LOG,CONVERSATION_MESSAGE";

function chatgptRecord(e) {
  const actor = e.actor?.type === "ACCOUNT_USER"
    ? { id: e.actor.user_id, email: e.actor.user_email, type: "user" }
    : e.actor?.type === "API_KEY"
      ? { id: e.actor.redacted_id, type: "api_key" }
      : e.actor
        ? { id: e.actor.provider_user_id, type: String(e.actor.type || "").toLowerCase() || undefined }
        : undefined;
  const base = { vendorId: e.event_id, ts: e.timestamp, actor, ip: e.request_metadata?.client_ip };
  if (e.type === "CONVERSATION_MESSAGE") {
    const m = e.message || {};
    const c = e.conversation || {};
    const text = m.content?.value ?? m.content?.quote ?? "";
    return {
      ...base,
      product: "chatgpt",
      action: `conversation_message:${m.author?.type || "unknown"}`,
      target: c.id,
      content: typeof text === "string" ? text : JSON.stringify(text),
      details: {
        conversationMode: c.mode,
        gpt: c.gpt_name || c.gpt_id,
        project: c.project_name || c.project_id,
        temporaryChat: c.is_temporary_chat || undefined,
        model: m.author?.model,
        toolsUsed: m.author?.tools_used,
        files: Array.isArray(m.files) ? m.files.length || undefined : undefined,
        contentType: m.content?.type
      }
    };
  }
  if (e.type === "AUTH_LOG") {
    return { ...base, product: "chatgpt", action: `auth:${e.action_data?.action || "event"}`, details: { provider: e.action_data?.auth_provider_name, application: e.action_data?.application_name, scopes: e.action_data?.granted_scopes } };
  }
  return {
    ...base,
    product: e.type === "CODEX_LOG" || e.type === "CODEX_SECURITY_LOG" ? "codex" : "chatgpt",
    action: e.action ? `${String(e.type).toLowerCase()}:${e.action}` : String(e.type || "event").toLowerCase(),
    details: { result: e.action_result, privilege: e.action_privilege, destination: e.request_metadata?.destination_hostname, ...(e.action_data && typeof e.action_data === "object" ? e.action_data : {}) }
  };
}

export const chatgptEnterprise = {
  id: "chatgpt-enterprise",
  name: "ChatGPT Enterprise (compliance logs)",
  product: "chatgpt",
  description: "ChatGPT Enterprise and Edu compliance log files: conversations, audit and auth events, Codex.",
  covers: "every ChatGPT conversation message (text scanned, then kept as a hash), workspace audit and sign-in events, and Codex logs if selected",
  limits: "ChatGPT Enterprise or Edu. A workspace Admin key with the compliance logs read scope for each log type, created by a workspace owner. Files are retained 30 days and delivered at least once, within about 30 minutes.",
  credentials: [{ env: "CHATGPT_COMPLIANCE_KEY", description: "ChatGPT workspace Admin key with chatgpt.enterprise.compliance_logs_platform read scopes" }],
  settings: [
    { key: "workspaceId", description: "ChatGPT workspace id", required: true },
    { key: "eventTypes", description: `Comma-separated log types (default ${DEFAULT_CHATGPT_TYPES}; also CODEX_LOG, CODEX_SECURITY_LOG, CUSTOM_AGENTS_LOG, ...)` }
  ],
  defaultIntervalMinutes: 15,

  async *pages({ state, config }) {
    const base = envBaseUrl(this.id, "https://api.chatgpt.com");
    const headers = { authorization: `Bearer ${process.env.CHATGPT_COMPLIANCE_KEY}` };
    const root = `${base}/v1/compliance/workspaces/${encodeURIComponent(config.workspaceId)}/logs`;
    let after = state.cursor || new Date(Date.now() - DAY_MS).toISOString();
    for (;;) {
      const qs = new URLSearchParams({ event_type: config.eventTypes || DEFAULT_CHATGPT_TYPES, after, limit: "100" });
      const list = await vendorFetch(`${root}?${qs}`, { headers });
      for (const file of list.json?.data || []) {
        // The download redirects to a short-lived signed URL. The redirect is
        // followed here, without the key: a signed URL needs no credential,
        // and must never be handed the workspace's admin key.
        let r = await vendorFetch(`${root}/${encodeURIComponent(file.id)}`, { headers, redirect: "manual" });
        if (r.location) r = await vendorFetch(r.location, {});
        if (file.file_sha256) {
          const actual = crypto.createHash("sha256").update(r.text).digest("hex");
          if (actual !== String(file.file_sha256).toLowerCase()) throw new Error(`Log file ${file.id} failed its SHA-256 check; not recorded.`);
        }
        const records = [];
        for (const line of r.text.split("\n")) {
          if (!line.trim()) continue;
          try {
            records.push(chatgptRecord(JSON.parse(line)));
          } catch {
            // a malformed line is skipped; the rest of the file still counts
          }
        }
        yield { records, cursor: file.end_time };
      }
      if (!list.json?.has_more || !list.json?.last_end_time) return;
      after = list.json.last_end_time;
    }
  }
};
