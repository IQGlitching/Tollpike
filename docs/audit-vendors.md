# Hosted agents: pulling the vendors' own audit logs

ChatGPT, Claude.ai, Microsoft 365 Copilot, GitHub Copilot, Gemini and Cursor
talk to their own vendor, so no other layer of Tollpike can see them. Their
vendors keep audit logs, and enterprise plans expose them over an API. This
layer pulls those logs on a schedule, checks them against the same rules, and
writes them into the same hash-chained record, so one export covers the
agents that go through Tollpike and the ones that do not.

## Connectors

| Id | Product | What it brings in | Message text |
|---|---|---|---|
| `chatgpt-enterprise` | ChatGPT Enterprise / Edu | every conversation message, workspace audit and sign-in events, optionally Codex logs | scanned, then kept as a hash |
| `openai-platform` | OpenAI API platform | logins, API keys, projects, members and roles, SSO and SCIM, IP allowlists, service accounts | none |
| `anthropic-compliance` | Claude (Claude.ai, Claude Code, Console) | the Compliance API activity feed: sign-ins, chats and projects, members and roles, keys, SSO, exports | none |
| `anthropic-admin` | Anthropic API platform | changes to users, invites and API keys, found by comparing snapshots | none |
| `microsoft-copilot` | Microsoft 365 Copilot | every Copilot interaction tenant-wide: user, app, files accessed and their sensitivity labels, model | none in the record |
| `microsoft-copilot-chat` | Microsoft 365 Copilot | the prompts and responses themselves, per user | scanned, then kept as a hash |
| `github-copilot` | GitHub Copilot | seats, plans, policies, content exclusion, custom instructions, coding-agent configuration | none (GitHub logs administration only) |
| `google-gemini` | Gemini in Workspace and NotebookLM | who used Gemini, in which app, for what action | none |
| `cursor` | Cursor | logins, membership, API keys, settings, MCP and hook configuration, cloud agents | none |

`tollpike audit vendors` lists them with what each needs and whether it is
configured.

## What gets recorded

- **`vendor.activity`** for each record, with the vendor's own event id and
  time, the action, the actor, the source IP, the target, and the details
  (redacted).
- **`vendor.pull`** for every run that fetched something or failed, and once a
  day for an idle connector. A failed run is flagged
  (`vendor.pull_failed`), because a collection gap is itself an audit finding.

Rules run on every record:

- **Privileged changes** at the vendor are flagged
  (`vendor.privileged_change`): API or admin keys created, roles granted, SSO,
  SCIM or MFA changes, audit-log or retention changes, data exports, IP
  allowlist changes.
- **Message text**, where the vendor provides it (ChatGPT Enterprise,
  Microsoft Graph), goes through the prompt rules: credentials and personal
  data. The text is then dropped. The record keeps a SHA-256 and a length, so
  a message produced later can be matched to the record, but the audit trail
  never becomes a second copy of every conversation.

## Configuration

Credentials go in the environment (the gateway's credential file,
`~/.tollpike/.env`), never in settings. Status reports only whether each one
is present. Identifiers such as tenant, workspace or organization go in
settings:

```bash
# in ~/.tollpike/.env on the gateway host
CHATGPT_COMPLIANCE_KEY=...
ANTHROPIC_COMPLIANCE_KEY=...
MS365_CLIENT_ID=...
MS365_CLIENT_SECRET=...
```

```bash
curl -X POST http://127.0.0.1:20128/api/panel/audit/settings \
  -H "content-type: application/json" \
  -d '{"vendors": {
        "chatgpt-enterprise":   {"enabled": true, "workspaceId": "<workspace id>"},
        "anthropic-compliance": {"enabled": true},
        "microsoft-copilot":    {"enabled": true, "tenantId": "<tenant GUID>"}
      }}'
```

Then check one before relying on the schedule:

```bash
tollpike audit vendors pull chatgpt-enterprise
```

Enabled connectors are pulled on a schedule (default 15 to 60 minutes per
connector, `intervalMinutes` from 5 to 1440). Each keeps a cursor, saved after
every page, so a restart or an outage resends at most one page. The vendor's
event ids remove the duplicates.

## What each vendor requires

| Connector | Plan | Credential | Notes |
|---|---|---|---|
| `chatgpt-enterprise` | ChatGPT Enterprise or Edu | workspace Admin key with the compliance-logs read scopes, created by a workspace owner | Files are kept 30 days: pull at least weekly. Each file's published SHA-256 is checked; a file that fails is not recorded and the run is flagged. The signed download URL is never sent the key. |
| `openai-platform` | any API organization | organization Admin key with Audit Logs: Read, created by an owner | Audit logging must be switched on in the organization (it cannot be switched off again). OpenAI keeps the log best-effort, so this copy is the durable one. Set `includeTenant` to `"true"` for SSO and tenant-level events. |
| `anthropic-compliance` | Claude Enterprise, or an eligible Console organization | Compliance Access Key with `read:compliance_activities` (or an Admin key created after enablement) | The Primary Owner enables the Compliance API; recording starts then, not retroactively. |
| `anthropic-admin` | API organization | Admin API key | The first pull is a baseline. A change is timed when a pull sees it, except new users and keys, which carry their own creation time. |
| `microsoft-copilot` | Microsoft 365 with unified audit logging | Entra app with Office 365 Management APIs `ActivityFeed.Read` (application) and a client secret | Set `tenantId`. A new subscription can take up to 12 hours to produce content, and content older than 7 days cannot be fetched. |
| `microsoft-copilot-chat` | Microsoft 365 Copilot licences | Entra app with Graph `AiEnterpriseInteraction.Read.All` and `User.Read.All` (application) | Per user: the connector lists users and asks for each. Copilot Studio agents are not included. |
| `github-copilot` | GitHub Enterprise Cloud | organization owner token with `read:audit_log` (or Administration: read), or an enterprise admin's classic token | Set `org` or `enterprise`. |
| `google-gemini` | Google Workspace with Gemini | service account JSON key (`GOOGLE_SERVICE_ACCOUNT_FILE`) with domain-wide delegation for `admin.reports.audit.readonly` | Set `adminEmail` to the admin it acts as. Logs exist from 2025-06-20, 180 days back. |
| `cursor` | Cursor Enterprise | Admin API key | 20 requests per minute. |

## How each connector was built

Each connector file names the vendor documentation it follows and the date it
was checked (2026-10-03). The tests run every connector against a mock that
answers the documented paths with the documented response shapes, checks
authentication the way the vendor does, and verifies a real signed JWT for
Google. No connector has yet been run against a live vendor tenant: treat the
first pull on each as the verification step, and check its `vendor.pull`
record.

Points the vendor documentation leaves open, handled conservatively:

- Microsoft Graph interaction history: paging through `@odata.nextLink` is
  assumed (standard Graph behaviour, not stated on the method page).
- Microsoft Management API: the token uses the documented v1 `resource=` flow,
  with a client secret.
- OpenAI audit log: the sort order is not documented. The connector reads
  everything after its cursor and does not depend on the order.
- GitHub enterprise audit log: documented as classic-token only, though also
  listed for GitHub App tokens. A classic token is what the connector expects.

## Not covered

- Vendors with no audit-log API on your plan, and anything a vendor does not
  put in its own log (GitHub, Cursor and Gemini log administration and usage,
  not prompts).
- Claude.ai chat contents (the Compliance API's chat endpoints): the activity
  feed is pulled, the conversations are not.
- GitHub Copilot usage records for EMU enterprises (public preview), and the
  report-file metrics APIs that replaced GitHub's legacy Copilot metrics.
