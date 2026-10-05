// GitHub Copilot, through the organization or enterprise audit log.
//
// Copilot administration only: seats assigned and removed, policy and
// content-exclusion changes, custom instructions, coding-agent firewall and
// MCP configuration. GitHub's audit log does not contain prompts or
// completions. (The legacy /copilot/metrics API was shut down on 2026-04-02
// and is not used.)
//
// Sources: docs.github.com enterprise-cloud rest/orgs/orgs#get-the-audit-log-
// for-an-organization, rest/enterprise-admin/audit-log, and the audit log
// event lists for organizations and enterprises (checked 2026-10-03).

import { vendorFetch, envBaseUrl } from "../framework.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function nextAfter(link) {
  // Link: <https://api.github.com/...&after=CURSOR>; rel="next"
  const m = String(link || "").match(/<([^>]+)>;\s*rel="next"/);
  if (!m) return null;
  try {
    return new URL(m[1]).searchParams.get("after");
  } catch {
    return null;
  }
}

export const githubCopilot = {
  id: "github-copilot",
  name: "GitHub Copilot (audit log)",
  product: "github-copilot",
  description: "copilot.* events from the GitHub Enterprise Cloud organization or enterprise audit log.",
  covers: "Copilot seats, plans, policies, content exclusion, custom instructions and coding-agent configuration changes; no prompts or completions",
  limits: "GitHub Enterprise Cloud. Organization: an owner's token with read:audit_log (classic) or Administration: read (fine-grained). Enterprise: a classic token with read:audit_log from an enterprise admin. 1,750 queries per hour.",
  credentials: [{ env: "GITHUB_AUDIT_TOKEN", description: "Token with read:audit_log (see limits)" }],
  settings: [
    { key: "org", description: "Organization login (set org or enterprise)" },
    { key: "enterprise", description: "Enterprise slug (set org or enterprise)" }
  ],
  defaultIntervalMinutes: 30,
  // Read oldest first (order=asc), so a progress cursor never skips anything.
  ascending: true,

  async *pages({ state, config }) {
    if (!config.org && !config.enterprise) throw new Error("Set audit.vendors.github-copilot.org or .enterprise.");
    const base = envBaseUrl(this.id, "https://api.github.com");
    const scope = config.enterprise ? `enterprises/${encodeURIComponent(config.enterprise)}` : `orgs/${encodeURIComponent(config.org)}`;
    const since = state.cursor || new Date(Date.now() - DAY_MS).toISOString();
    const phrase = `action:copilot created:>=${since.slice(0, 19)}Z`;
    const headers = { authorization: `Bearer ${process.env.GITHUB_AUDIT_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2026-03-10" };
    let after = null;
    let newest = since;
    for (;;) {
      const qs = new URLSearchParams({ phrase, include: "all", order: "asc", per_page: "100", ...(after ? { after } : {}) });
      const r = await vendorFetch(`${base}/${scope}/audit-log?${qs}`, { headers });
      const rows = Array.isArray(r.json) ? r.json : [];
      const records = rows.map((e) => {
        const ts = new Date(Number(e["@timestamp"] ?? e.created_at)).toISOString();
        if (ts > newest) newest = ts;
        return {
          vendorId: e._document_id || `${e["@timestamp"]}|${e.action}|${e.actor}`,
          ts,
          action: e.action,
          actor: { id: e.actor, type: e.actor_is_agent ? "agent" : "user" },
          target: e.user || e.repo || e.org || e.business,
          details: Object.fromEntries(
            ["org", "repo", "user", "business", "plan", "old_plan", "new_value", "old_value", "excluded_paths", "owner", "owner_type", "oauth_application_id", "user_programmatic_access_name"]
              .filter((k) => e[k] !== undefined)
              .map((k) => [k, e[k]])
          )
        };
      });
      after = nextAfter(r.headers.get("link"));
      yield { records, cursor: after ? undefined : newest };
      if (!after || !rows.length) return;
    }
  }
};
