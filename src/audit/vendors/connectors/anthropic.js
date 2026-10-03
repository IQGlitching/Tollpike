// Anthropic: Claude's own audit log, and the Admin API's registers.
//
//   anthropic-compliance  The Compliance API activity feed
//                    (GET /v1/compliance/activities): Claude.ai and Console
//                    activity across the organization, from sign-ins and
//                    chats created to keys, roles, SSO and exports. Retained
//                    six years at Anthropic; queryable within a minute.
//   anthropic-admin  The Admin API has no event log, so this one compares
//                    snapshots: users, pending invites and API keys are read
//                    on each pull and differences become records (a user
//                    added or removed, a role changed, a key created or its
//                    status changed). Useful for API-platform organizations
//                    without the Compliance API.
//
// Sources: platform.claude.com/docs/en/manage-claude/compliance-api,
// compliance-activity-feed, api/compliance/activities/list, and
// manage-claude/admin-api with the organization API reference
// (checked 2026-10-03).

import crypto from "node:crypto";
import { vendorFetch, envBaseUrl } from "../framework.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const VERSION = "2023-06-01";
const SKIP = new Set(["id", "created_at", "type", "actor", "organization_id", "organization_uuid"]);

function actorOf(a) {
  if (!a) return undefined;
  switch (a.type) {
    case "user_actor":
      return { id: a.user_id, email: a.email_address, type: "user" };
    case "api_actor":
      return { id: a.api_key_id, type: "api_key" };
    case "admin_api_key_actor":
      return { id: a.admin_api_key_id, type: "admin_api_key" };
    case "unauthenticated_user_actor":
      return { email: a.unauthenticated_email_address, type: "unauthenticated" };
    case "system_actor":
      return { id: a.service, type: "system" };
    case "scim_directory_sync_actor":
      return { id: a.directory_id, type: "scim" };
    default:
      return { type: a.type };
  }
}

export const anthropicCompliance = {
  id: "anthropic-compliance",
  name: "Claude (Compliance API activity feed)",
  product: "claude",
  description: "Organization activity from Anthropic's Compliance API: Claude.ai, Claude Code and Console.",
  covers: "sign-ins, chats, projects and files created or deleted, members and roles, API and admin keys, SSO, compliance and export settings; no message text",
  limits: "The Compliance API must be enabled by the Primary Owner (not retroactive). A Compliance Access Key with read:compliance_activities, or an Admin key created after enablement. 600 requests per minute.",
  credentials: [{ env: "ANTHROPIC_COMPLIANCE_KEY", description: "Compliance Access Key (or Admin key) with read:compliance_activities" }],
  settings: [],
  defaultIntervalMinutes: 15,

  async *pages({ state }) {
    const base = envBaseUrl(this.id, "https://api.anthropic.com");
    const headers = { "x-api-key": process.env.ANTHROPIC_COMPLIANCE_KEY, "anthropic-version": VERSION };
    const since = state.cursor || new Date(Date.now() - DAY_MS).toISOString();
    let newest = since;
    let afterId = null;
    // Newest first: walk back to the cursor, then move the cursor to the newest seen.
    for (;;) {
      const qs = new URLSearchParams({ "created_at.gt": since, limit: "1000", ...(afterId ? { after_id: afterId } : {}) });
      const r = await vendorFetch(`${base}/v1/compliance/activities?${qs}`, { headers });
      const rows = r.json?.data || [];
      const records = rows.map((a) => {
        if (a.created_at > newest) newest = a.created_at;
        const details = Object.fromEntries(Object.entries(a).filter(([k, v]) => !SKIP.has(k) && v !== null && v !== undefined));
        return {
          vendorId: a.id,
          ts: a.created_at,
          action: a.type,
          actor: actorOf(a.actor),
          ip: a.actor?.ip_address,
          target: a.claude_chat_id || a.claude_project_id || a.claude_file_id || undefined,
          details: { ...details, organization: a.organization_id || undefined }
        };
      });
      yield { records };
      if (!r.json?.has_more || !r.json?.last_id) break;
      afterId = r.json.last_id;
    }
    yield { records: [], cursor: newest };
  }
};

async function listAll(base, path, headers, extra = {}) {
  const out = [];
  let afterId = null;
  for (;;) {
    const qs = new URLSearchParams({ limit: "1000", ...extra, ...(afterId ? { after_id: afterId } : {}) });
    const r = await vendorFetch(`${base}${path}?${qs}`, { headers });
    out.push(...(r.json?.data || []));
    if (!r.json?.has_more || !r.json?.last_id) return out;
    afterId = r.json.last_id;
  }
}

function fingerprint(o) {
  return crypto.createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 16);
}

export const anthropicAdmin = {
  id: "anthropic-admin",
  name: "Anthropic API organization (Admin API changes)",
  product: "anthropic-api",
  description: "Changes to users, invites and API keys, found by comparing Admin API snapshots.",
  covers: "users added or removed, role changes, invites, API keys created or changing status; no prompts. Changes are seen at pull time, not as they happen.",
  limits: "An Admin API key (sk-ant-admin...). The first pull records the current state as a baseline; changes are recorded from the second pull on. The time on a change record is when the pull saw it, except for a new key or user, which carries its own creation time.",
  credentials: [{ env: "ANTHROPIC_ADMIN_KEY", description: "Anthropic Admin API key" }],
  settings: [],
  defaultIntervalMinutes: 30,

  async *pages({ state }) {
    const base = envBaseUrl(this.id, "https://api.anthropic.com");
    const headers = { "x-api-key": process.env.ANTHROPIC_ADMIN_KEY, "anthropic-version": VERSION };
    const [users, invites, keys] = await Promise.all([
      listAll(base, "/v1/organizations/users", headers),
      listAll(base, "/v1/organizations/invites", headers),
      listAll(base, "/v1/organizations/api_keys", headers)
    ]);
    const now = {
      users: Object.fromEntries(users.map((u) => [u.id, { email: u.email, role: u.role, added_at: u.added_at }])),
      invites: Object.fromEntries(invites.map((i) => [i.id, { email: i.email, role: i.role, status: i.status, invited_at: i.invited_at }])),
      keys: Object.fromEntries(keys.map((k) => [k.id, { name: k.name, status: k.status, created_at: k.created_at, scope: k.scope?.type, workspace: k.scope?.workspace_id, createdBy: k.created_by?.id }]))
    };
    const prev = state.snapshot;
    const records = [];
    const at = new Date().toISOString();
    const rec = (action, id, ts, actorEmail, details) =>
      records.push({ vendorId: `${action}:${id}:${fingerprint(details)}`, ts: ts || at, action, actor: actorEmail ? { email: actorEmail, type: "user" } : undefined, target: id, details });

    if (prev) {
      for (const [id, u] of Object.entries(now.users)) {
        const was = prev.users?.[id];
        if (!was) rec("user.added", id, u.added_at, u.email, { role: u.role });
        else if (was.role !== u.role) rec("user.role_changed", id, null, u.email, { from: was.role, to: u.role });
      }
      for (const [id, u] of Object.entries(prev.users || {})) if (!now.users[id]) rec("user.removed", id, null, u.email, { role: u.role });
      for (const [id, i] of Object.entries(now.invites)) {
        const was = prev.invites?.[id];
        if (!was) rec("invite.sent", id, i.invited_at, i.email, { role: i.role });
        else if (was.status !== i.status) rec(`invite.${i.status}`, id, null, i.email, { role: i.role, from: was.status });
      }
      for (const [id, k] of Object.entries(now.keys)) {
        const was = prev.keys?.[id];
        if (!was) rec("api_key.created", id, k.created_at, null, { name: k.name, scope: k.scope, workspace: k.workspace, createdBy: k.createdBy });
        else if (was.status !== k.status) rec("api_key.status_changed", id, null, null, { name: k.name, from: was.status, to: k.status });
      }
    }
    // The snapshot rides in the cursor field of the state, saved after this page.
    state.snapshot = now;
    yield { records, cursor: at };
  }
};
