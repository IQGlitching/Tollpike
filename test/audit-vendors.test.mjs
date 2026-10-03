// Audit layer four: vendor audit-log connectors.
//
// No vendor is contacted. One local server plays every vendor, answering the
// documented paths with the documented response shapes, and checking each
// request the way the vendor would (the right auth header, the right token
// grant, a JWT that actually verifies). Credentials are test values made up
// here; base URLs are pointed at the mock through the environment.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tollpike-audit4-"));
process.env.TOLLPIKE_DATA_DIR = DATA_DIR;
process.env.TOLLPIKE_ENV_FILE = path.join(DATA_DIR, "no-such.env");
process.env.TOLLPIKE_SECRET = "audit-layer4-test-secret";
delete process.env.TOLLPIKE_AUDIT;

// Test credentials: made up for this suite, valid nowhere.
const CREDS = {
  OPENAI_ADMIN_KEY: "test-openai-admin-value-0001",
  CHATGPT_COMPLIANCE_KEY: "test-chatgpt-compliance-value-0002",
  ANTHROPIC_COMPLIANCE_KEY: "test-anthropic-compliance-value-0003",
  ANTHROPIC_ADMIN_KEY: "test-anthropic-admin-value-0004",
  MS365_CLIENT_ID: "11111111-2222-3333-4444-555555555555",
  MS365_CLIENT_SECRET: "test-ms-client-secret-value-0005",
  GITHUB_AUDIT_TOKEN: "test-github-audit-value-0006",
  CURSOR_ADMIN_API_KEY: "test-cursor-admin-value-0007"
};

// --- the mock vendor ------------------------------------------------------------

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const keyFile = path.join(DATA_DIR, "sa.json");
fs.writeFileSync(keyFile, JSON.stringify({ client_email: "audit@test-project.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) }));

const T = (minsAgo) => new Date(Date.now() - minsAgo * 60_000).toISOString();
const world = {
  anthropicUsers: [{ id: "user_1", email: "a@corp.example", role: "user", added_at: T(5000) }],
  anthropicKeys: [],
  chatgptTamper: false,
  requests: []
};

// Built once: a log file is immutable, so its listing hash and its download
// must describe the same bytes.
const CHATGPT_FILE =
  [
    { event_id: "ev-1", type: "CONVERSATION_MESSAGE", timestamp: T(30), principal: { id: "ws", type: "CHATGPT_WORKSPACE" }, actor: { type: "ACCOUNT_USER", user_id: "user-9", user_email: "dev@corp.example" }, message: { id: "m1", author: { type: "user" }, content: { type: "text", value: "deploy with AKIAABCDEFGHIJKLMNOP please" } }, conversation: { id: "conv-1", mode: "chat", is_temporary_chat: false } },
    { event_id: "ev-2", type: "AUDIT_LOG", timestamp: T(29), actor: { type: "ACCOUNT_USER", user_id: "user-1", user_email: "admin@corp.example" }, action: "workspace_data_export", action_result: "SUCCESS", action_privilege: "ADMIN", request_metadata: { client_ip: "203.0.113.5" } },
    { event_id: "ev-3", type: "AUTH_LOG", timestamp: T(28), actor: { type: "ACCOUNT_USER", user_id: "user-9" }, request_metadata: { client_ip: "203.0.113.9" }, action_data: { action: "login_success", auth_provider_name: "okta" } }
  ]
    .map((l) => JSON.stringify(l))
    .join("\n") + "\n";
const chatgptLines = () => CHATGPT_FILE;

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function verifyGoogleJwt(assertion) {
  const [h, p, s] = assertion.split(".");
  const ok = crypto.createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s, "base64url"));
  return ok ? JSON.parse(Buffer.from(p, "base64url").toString()) : null;
}

let mockBase;
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://mock");
    const p = u.pathname;
    const q = u.searchParams;
    const auth = req.headers.authorization || "";
    world.requests.push({ path: p, query: Object.fromEntries(q), auth: auth ? "present" : "absent", apiKeyHeader: req.headers["x-api-key"] ? "present" : "absent" });

    // OpenAI platform audit log
    if (p === "/v1/organization/audit_logs") {
      if (auth !== `Bearer ${CREDS.OPENAI_ADMIN_KEY}`) return send(res, 401, { error: { message: "bad key" } });
      const now = Math.floor(Date.now() / 1000);
      if (!q.get("after")) {
        return send(res, 200, { object: "list", data: [{ id: "audit_log-a", type: "api_key.created", effective_at: now - 60, actor: { type: "session", session: { user: { id: "user-x", email: "owner@corp.example" }, ip_address: "198.51.100.1" } }, project: { id: "proj_1", name: "prod" }, "api_key.created": { id: "key_1", data: { scopes: ["/v1/*"] } } }], first_id: "audit_log-a", last_id: "audit_log-a", has_more: true });
      }
      return send(res, 200, { object: "list", data: [{ id: "audit_log-b", type: "login.succeeded", effective_at: now - 120, actor: { type: "session", session: { user: { id: "user-y", email: "dev@corp.example" }, ip_address: "198.51.100.2" } } }], first_id: "audit_log-b", last_id: "audit_log-b", has_more: false });
    }

    // ChatGPT compliance logs
    if (p === "/v1/compliance/workspaces/ws-1/logs") {
      if (auth !== `Bearer ${CREDS.CHATGPT_COMPLIANCE_KEY}`) return send(res, 401, { error: { message: "bad key" } });
      const body = chatgptLines();
      const sha = crypto.createHash("sha256").update(body).digest("hex");
      return send(res, 200, { data: [{ id: "file-1", event_type: "CONVERSATION_MESSAGE", end_time: T(20), file_sha256: world.chatgptTamper ? "0".repeat(64) : sha }], has_more: false, last_end_time: T(20) });
    }
    if (p === "/v1/compliance/workspaces/ws-1/logs/file-1") {
      if (auth !== `Bearer ${CREDS.CHATGPT_COMPLIANCE_KEY}`) return send(res, 401, {});
      // The real API redirects to a signed URL; so does the mock.
      res.writeHead(307, { location: `${mockBase}/signed/file-1?sig=abc` });
      return res.end();
    }
    if (p === "/signed/file-1") {
      if (auth) return send(res, 400, { error: "the signed URL must not receive the vendor key" });
      res.writeHead(200, { "content-type": "application/jsonl" });
      return res.end(chatgptLines());
    }

    // Anthropic compliance activities (newest first)
    if (p === "/v1/compliance/activities") {
      if (req.headers["x-api-key"] !== CREDS.ANTHROPIC_COMPLIANCE_KEY || req.headers["anthropic-version"] !== "2023-06-01") return send(res, 401, { error: { message: "bad key" } });
      if (!q.get("after_id")) return send(res, 200, { data: [{ id: "activity_2", created_at: T(2), type: "admin_api_key_created", actor: { type: "user_actor", email_address: "owner@corp.example", user_id: "user_o", ip_address: "192.0.2.10" }, organization_id: "org_1" }], has_more: true, first_id: "activity_2", last_id: "activity_2" });
      return send(res, 200, { data: [{ id: "activity_1", created_at: T(3), type: "claude_chat_created", actor: { type: "user_actor", email_address: "dev@corp.example", user_id: "user_d", ip_address: "192.0.2.11" }, claude_chat_id: "chat_1", organization_id: "org_1" }], has_more: false, first_id: "activity_1", last_id: "activity_1" });
    }

    // Anthropic admin registers
    if (p.startsWith("/v1/organizations/")) {
      if (req.headers["x-api-key"] !== CREDS.ANTHROPIC_ADMIN_KEY) return send(res, 401, {});
      const data = p.endsWith("/users") ? world.anthropicUsers : p.endsWith("/api_keys") ? world.anthropicKeys : [];
      return send(res, 200, { data, has_more: false, first_id: null, last_id: null });
    }

    // Microsoft login (v1 for the Management API, v2 for Graph)
    if (p === "/tenant-1/oauth2/token" || p === "/tenant-1/oauth2/v2.0/token") {
      const f = new URLSearchParams(raw);
      if (f.get("client_secret") !== CREDS.MS365_CLIENT_SECRET || f.get("grant_type") !== "client_credentials") return send(res, 400, { error_description: "bad client" });
      if (p.includes("v2.0") ? f.get("scope") !== "https://graph.microsoft.com/.default" : f.get("resource") !== "https://manage.office.com") return send(res, 400, { error_description: "wrong audience" });
      return send(res, 200, { access_token: p.includes("v2.0") ? "graph-token" : "manage-token", expires_in: 3600 });
    }
    // Office 365 Management Activity API
    if (p === "/api/v1.0/tenant-1/activity/feed/subscriptions/start") {
      if (auth !== "Bearer manage-token") return send(res, 401, {});
      return send(res, 400, { error: { code: "AF20024", message: "The subscription is already enabled." } });
    }
    if (p === "/api/v1.0/tenant-1/activity/feed/subscriptions/content") {
      if (auth !== "Bearer manage-token") return send(res, 401, {});
      if (!q.get("nextPage")) {
        return send(res, 200, [{ contentType: "Audit.General", contentId: "c1", contentUri: `${mockBase}/blob/c1`, contentCreated: T(10) }], { NextPageUri: `${mockBase}${p}?contentType=Audit.General&nextPage=2` });
      }
      return send(res, 200, [{ contentType: "Audit.General", contentId: "c2", contentUri: `${mockBase}/blob/c2`, contentCreated: T(9) }]);
    }
    if (p === "/blob/c1") {
      return send(res, 200, [
        { Id: "rec-copilot", RecordType: 261, Operation: "CopilotInteraction", Workload: "Copilot", CreationTime: "2026-10-03T08:00:00", UserId: "dev@corp.example", UserType: 0, ClientIP: "203.0.113.20", CopilotEventData: { AppHost: "Word", ThreadId: "19:abc@thread.v2", Contexts: [{ Id: "https://corp.sharepoint.com/plan.docx", Type: "docx" }], Messages: [{ Id: "1", isPrompt: true }, { Id: "2", isPrompt: false }], AccessedResources: [{ Id: "r1", SensitivityLabelId: "label-confidential", Action: "Read" }], ModelTransparencyDetails: [{ ModelProviderName: "OpenAI", ModelName: "gpt" }] } },
        { Id: "rec-exchange", RecordType: 2, Operation: "Send", Workload: "Exchange", CreationTime: "2026-10-03T08:00:01", UserId: "x@corp.example" }
      ]);
    }
    if (p === "/blob/c2") return send(res, 200, [{ Id: "rec-plugin", RecordType: 312, Operation: "CopilotPluginUpdated", Workload: "Copilot", CreationTime: "2026-10-03T08:00:02", UserId: "admin@corp.example" }]);

    // Microsoft Graph
    if (p === "/v1.0/users") {
      if (auth !== "Bearer graph-token") return send(res, 401, {});
      return send(res, 200, { value: [{ id: "u1", userPrincipalName: "dev@corp.example" }, { id: "u2", userPrincipalName: "nolicense@corp.example" }] });
    }
    if (p === "/v1.0/copilot/users/u1/interactionHistory/getAllEnterpriseInteractions") {
      // The first request must bound the window; a nextLink carries Graph's own token.
      if (!q.get("$skiptoken") && !q.get("$filter")?.includes("createdDateTime gt")) return send(res, 400, { error: { message: "filter required" } });
      if (!q.get("$skiptoken")) return send(res, 200, { value: [{ id: "int-1", sessionId: "s1", requestId: "r1", appClass: "IPM.SkypeTeams.Message.Copilot.BizChat", interactionType: "userPrompt", createdDateTime: T(15), from: { user: { id: "u1" } }, body: { contentType: "text", content: "summarise the mail from jane.doe@corp.example" } }], "@odata.nextLink": `${mockBase}${p}?$skiptoken=2` });
      return send(res, 200, { value: [{ id: "int-2", requestId: "r1", appClass: "IPM.SkypeTeams.Message.Copilot.BizChat", interactionType: "aiResponse", createdDateTime: T(15), from: { application: { id: "copilot" } }, body: { contentType: "html", content: "<p>Here is the summary.</p>" } }] });
    }
    if (p === "/v1.0/copilot/users/u2/interactionHistory/getAllEnterpriseInteractions") return send(res, 404, { error: { message: "no license" } });

    // GitHub audit log
    if (p === "/orgs/corp/audit-log") {
      if (auth !== `Bearer ${CREDS.GITHUB_AUDIT_TOKEN}` || !String(q.get("phrase")).startsWith("action:copilot")) return send(res, 401, {});
      if (!q.get("after")) return send(res, 200, [{ "@timestamp": Date.now() - 60_000, _document_id: "doc-1", action: "copilot.content_exclusion_changed", actor: "octo-admin", org: "corp", excluded_paths: ["secrets/**"] }], { Link: `<${mockBase}/orgs/corp/audit-log?after=CURSOR2&per_page=100>; rel="next"` });
      return send(res, 200, [{ "@timestamp": Date.now() - 30_000, _document_id: "doc-2", action: "copilot.cfb_seat_added", actor: "octo-admin", user: "newdev", org: "corp" }]);
    }

    // Google
    if (p === "/token") {
      const f = new URLSearchParams(raw);
      const claims = verifyGoogleJwt(f.get("assertion") || "");
      if (!claims || claims.sub !== "admin@corp.example" || !claims.scope.includes("admin.reports.audit.readonly")) return send(res, 400, { error: "invalid_grant" });
      return send(res, 200, { access_token: "google-token", expires_in: 3600 });
    }
    if (p.startsWith("/admin/reports/v1/activity/users/all/applications/")) {
      if (auth !== "Bearer google-token") return send(res, 401, {});
      const app = p.split("/").pop();
      if (app === "gemini_in_workspace_apps") {
        if (!q.get("pageToken")) return send(res, 200, { kind: "reports#activities", items: [{ id: { time: T(40), uniqueQualifier: "q1", applicationName: app }, actor: { email: "dev@corp.example", profileId: "p1" }, ipAddress: "203.0.113.30", events: [{ type: "ai_usage_event", name: "feature_utilization", parameters: [{ name: "action", value: "summarize" }, { name: "app_name", value: "gmail" }] }] }], nextPageToken: "pg2" });
        return send(res, 200, { kind: "reports#activities", items: [{ id: { time: T(39), uniqueQualifier: "q2", applicationName: app }, actor: { email: "pm@corp.example" }, events: [{ type: "ai_usage_event", name: "feature_utilization", parameters: [{ name: "action", value: "generate_text" }, { name: "app_name", value: "docs" }] }] }] });
      }
      return send(res, 200, { kind: "reports#activities", items: [] });
    }

    // Cursor
    if (p === "/teams/audit-logs") {
      if (auth !== `Basic ${Buffer.from(`${CREDS.CURSOR_ADMIN_API_KEY}:`).toString("base64")}`) return send(res, 401, { error: "bad key" });
      return send(res, 200, { events: [{ event_id: "cur-1", timestamp: T(12), ip_address: "203.0.113.40", user_email: "lead@corp.example", event_type: "team_api_key_created", application_type: "cursor", event_data: { keyName: "ci" } }], pagination: { page: 1, pageSize: 500, totalCount: 1, totalPages: 1, hasNextPage: false } });
    }

    send(res, 404, { error: `mock has no route for ${p}` });
  });
});

let vendors;
let log;
let settings;

before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  mockBase = `http://127.0.0.1:${server.address().port}`;
  for (const id of ["OPENAI_PLATFORM", "CHATGPT_ENTERPRISE", "ANTHROPIC_COMPLIANCE", "ANTHROPIC_ADMIN", "MICROSOFT_COPILOT", "MICROSOFT_COPILOT_LOGIN", "MICROSOFT_COPILOT_CHAT", "MICROSOFT_COPILOT_CHAT_LOGIN", "GITHUB_COPILOT", "GOOGLE_GEMINI", "GOOGLE_GEMINI_TOKEN", "CURSOR"]) {
    process.env[`TOLLPIKE_VENDOR_${id}_BASE_URL`] = mockBase;
  }
  vendors = await import("../src/audit/vendors/index.js");
  log = await import("../src/audit/log.js");
  settings = await import("../src/storage/settings.js");
});

after(() => server.close());

const events = () => log.readEvents();
const vendorEvents = (vendor) => events().filter((e) => e.type === "vendor.activity" && e.vendor === vendor);
const configure = (vendorsPatch) => {
  const cur = settings.getSettings().audit;
  settings.updateSettings({ audit: { ...cur, vendors: { ...(cur.vendors || {}), ...vendorsPatch } } });
};

describe("catalog and configuration", () => {
  test("every connector is listed with what it covers and needs", () => {
    const ids = vendors.connectorCatalog().map((c) => c.id).sort();
    assert.deepEqual(ids, ["anthropic-admin", "anthropic-compliance", "chatgpt-enterprise", "cursor", "github-copilot", "google-gemini", "microsoft-copilot", "microsoft-copilot-chat", "openai-platform"]);
    for (const c of vendors.connectorCatalog()) {
      assert.ok(c.covers && c.limits && c.credentials.length, c.id);
    }
  });

  test("an unconfigured connector says exactly what is missing, and nothing is fetched", async () => {
    const before = world.requests.length;
    const r = await vendors.pullVendor("openai-platform");
    assert.equal(r.ok, false);
    assert.match(r.error, /env OPENAI_ADMIN_KEY/);
    assert.equal(world.requests.length, before);
  });

  test("status reports credential presence, never a value", () => {
    Object.assign(process.env, CREDS);
    process.env.GOOGLE_SERVICE_ACCOUNT_FILE = keyFile;
    const s = JSON.stringify(vendors.vendorsStatus());
    for (const v of Object.values(CREDS)) assert.ok(!s.includes(v), "a credential value appeared in status");
    assert.ok(vendors.vendorsStatus().find((x) => x.id === "openai-platform").credentials.OPENAI_ADMIN_KEY === true);
  });

  test("vendor settings are validated, and credentials are refused there", () => {
    const cat = vendors.connectorCatalog();
    assert.equal(settings.validateAudit({ vendors: { nope: {} } }, null, cat).ok, false);
    assert.equal(settings.validateAudit({ vendors: { "microsoft-copilot": { clientSecret: "x" } } }, null, cat).ok, false, "unknown setting");
    assert.equal(settings.validateAudit({ vendors: { "microsoft-copilot": { tenantId: "sk-abcdefghijklmnop" } } }, null, cat).ok, false, "credential-shaped value");
    assert.equal(settings.validateAudit({ vendors: { "microsoft-copilot": { tenantId: "tenant-1", enabled: true, intervalMinutes: 30 } } }, null, cat).ok, true);
    assert.equal(settings.validateAudit({ vendors: { "microsoft-copilot": { intervalMinutes: 1 } } }, null, cat).ok, false);
  });
});

describe("connectors against documented response shapes", () => {
  before(() => {
    configure({
      "chatgpt-enterprise": { workspaceId: "ws-1" },
      "microsoft-copilot": { tenantId: "tenant-1" },
      "microsoft-copilot-chat": { tenantId: "tenant-1" },
      "github-copilot": { org: "corp" },
      "google-gemini": { adminEmail: "admin@corp.example" }
    });
  });

  test("OpenAI platform: pages by last_id, flags a key creation", async () => {
    const r = await vendors.pullVendor("openai-platform");
    assert.equal(r.ok, true, r.error);
    assert.equal(r.recorded, 2);
    const created = vendorEvents("openai-platform").find((e) => e.action === "api_key.created");
    assert.equal(created.actor.email, "owner@corp.example");
    assert.equal(created.ip, "198.51.100.1");
    assert.equal(created.target, "prod");
    assert.ok(created.findings.some((f) => f.rule === "vendor.privileged_change"));
    assert.equal(created.flagged, true);
  });

  test("a second pull of the same records records nothing new", async () => {
    const r = await vendors.pullVendor("openai-platform");
    assert.equal(r.ok, true);
    assert.equal(r.recorded, 0);
    assert.equal(r.duplicates, 2);
  });

  test("ChatGPT Enterprise: follows the signed redirect without the key, verifies the file, scans and drops message text", async () => {
    const r = await vendors.pullVendor("chatgpt-enterprise");
    assert.equal(r.ok, true, r.error);
    assert.equal(r.recorded, 3);
    const msg = vendorEvents("chatgpt-enterprise").find((e) => e.action === "conversation_message:user");
    assert.ok(msg.contentHash && msg.contentChars > 0);
    assert.ok(msg.findings.some((f) => f.rule === "secret.in_prompt"), "the AWS key in the message is found");
    assert.ok(!fs.readFileSync(log.logPath, "utf8").includes("AKIAABCDEFGHIJKLMNOP"), "message text is never stored");
    const exp = vendorEvents("chatgpt-enterprise").find((e) => e.action === "audit_log:workspace_data_export");
    assert.ok(exp.findings.some((f) => f.rule === "vendor.privileged_change"));
    assert.equal(exp.ip, "203.0.113.5");
  });

  test("a log file that fails its SHA-256 check is not recorded, and the failed run is flagged", async () => {
    const st = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "vendor-state.json"), "utf8"));
    st["chatgpt-enterprise"] = { seen: [] };
    fs.writeFileSync(path.join(DATA_DIR, "vendor-state.json"), JSON.stringify(st));
    world.chatgptTamper = true;
    const before = vendorEvents("chatgpt-enterprise").length;
    const r = await vendors.pullVendor("chatgpt-enterprise");
    world.chatgptTamper = false;
    assert.equal(r.ok, false);
    assert.match(r.error, /SHA-256/);
    assert.equal(vendorEvents("chatgpt-enterprise").length, before);
    const pull = events().filter((e) => e.type === "vendor.pull" && e.vendor === "chatgpt-enterprise").at(-1);
    assert.equal(pull.outcome, "failed");
    assert.equal(pull.flagged, true);
  });

  test("Anthropic Compliance: walks newest-first pages and maps actors", async () => {
    const r = await vendors.pullVendor("anthropic-compliance");
    assert.equal(r.ok, true, r.error);
    assert.equal(r.recorded, 2);
    const chat = vendorEvents("anthropic-compliance").find((e) => e.action === "claude_chat_created");
    assert.equal(chat.target, "chat_1");
    assert.equal(chat.actor.email, "dev@corp.example");
    const key = vendorEvents("anthropic-compliance").find((e) => e.action === "admin_api_key_created");
    assert.ok(key.findings.some((f) => f.rule === "vendor.privileged_change"));
  });

  test("Anthropic Admin: the first pull is a baseline, later changes are recorded", async () => {
    let r = await vendors.pullVendor("anthropic-admin");
    assert.equal(r.ok, true, r.error);
    assert.equal(r.recorded, 0, "a baseline records nothing");
    world.anthropicUsers[0] = { ...world.anthropicUsers[0], role: "admin" };
    world.anthropicKeys.push({ id: "apikey_1", name: "ci", status: "active", created_at: T(1), scope: { type: "workspace", workspace_id: "wrkspc_1" }, created_by: { type: "user", id: "user_1" } });
    r = await vendors.pullVendor("anthropic-admin");
    assert.equal(r.recorded, 2);
    const actions = vendorEvents("anthropic-admin").map((e) => e.action).sort();
    assert.deepEqual(actions, ["api_key.created", "user.role_changed"]);
    assert.ok(vendorEvents("anthropic-admin").every((e) => e.flagged));
    r = await vendors.pullVendor("anthropic-admin");
    assert.equal(r.recorded, 0, "an unchanged register records nothing");
  });

  test("Microsoft 365 Copilot activity: v1 token for manage.office.com, existing subscription tolerated, NextPageUri followed, only Copilot records kept", async () => {
    const r = await vendors.pullVendor("microsoft-copilot");
    assert.equal(r.ok, true, r.error);
    const recs = vendorEvents("microsoft-copilot");
    assert.deepEqual(recs.map((e) => e.vendorEventId).sort(), ["rec-copilot", "rec-plugin"], "the Exchange record is filtered out");
    const c = recs.find((e) => e.vendorEventId === "rec-copilot");
    assert.equal(c.action, "CopilotInteraction:Word");
    assert.equal(c.actor.id, "dev@corp.example");
    assert.equal(c.details.prompts, 1);
    assert.deepEqual(c.details.sensitivityLabels, ["label-confidential"]);
    assert.equal(c.vendorTime, "2026-10-03T08:00:00.000Z", "CreationTime without a zone is UTC");
  });

  test("Microsoft 365 Copilot prompts: v2 Graph token, per-user history, unlicensed users skipped, text scanned then dropped", async () => {
    const r = await vendors.pullVendor("microsoft-copilot-chat");
    assert.equal(r.ok, true, r.error);
    const recs = vendorEvents("microsoft-copilot-chat");
    assert.equal(recs.length, 2);
    const prompt = recs.find((e) => e.action.startsWith("userPrompt"));
    assert.equal(prompt.actor.email, "dev@corp.example");
    assert.ok(prompt.findings.some((f) => f.rule === "pii.in_traffic"));
    assert.ok(!fs.readFileSync(log.logPath, "utf8").includes("jane.doe@corp.example"));
  });

  test("GitHub Copilot: copilot phrase, Link-header cursor, admin changes recorded", async () => {
    const r = await vendors.pullVendor("github-copilot");
    assert.equal(r.ok, true, r.error);
    const recs = vendorEvents("github-copilot");
    assert.deepEqual(recs.map((e) => e.action).sort(), ["copilot.cfb_seat_added", "copilot.content_exclusion_changed"]);
    assert.deepEqual(recs.find((e) => e.action === "copilot.content_exclusion_changed").details.excluded_paths, ["secrets/**"]);
    const second = world.requests.filter((x) => x.path === "/orgs/corp/audit-log").at(-1);
    assert.equal(second.query.after, "CURSOR2");
  });

  test("Gemini: service-account JWT verifies, both pages read", async () => {
    const r = await vendors.pullVendor("google-gemini");
    assert.equal(r.ok, true, r.error);
    const recs = vendorEvents("google-gemini");
    assert.equal(recs.length, 2);
    assert.equal(recs[0].action, "gemini_in_workspace_apps:feature_utilization:summarize");
    assert.equal(recs[0].details.app_name, "gmail");
  });

  test("Cursor: basic auth with the key as user name", async () => {
    const r = await vendors.pullVendor("cursor");
    assert.equal(r.ok, true, r.error);
    const e = vendorEvents("cursor")[0];
    assert.equal(e.action, "team_api_key_created");
    assert.ok(e.findings.some((f) => f.rule === "vendor.privileged_change"));
  });
});

describe("integrity", () => {
  test("every run is on the record, and no credential reached the log or the state file", () => {
    const pulls = events().filter((e) => e.type === "vendor.pull");
    assert.ok(pulls.length >= 9);
    const raw = fs.readFileSync(log.logPath, "utf8") + fs.readFileSync(path.join(DATA_DIR, "vendor-state.json"), "utf8");
    for (const v of Object.values(CREDS)) {
      if (v === CREDS.MS365_CLIENT_ID) continue; // a client id is an identifier, not a secret
      assert.ok(!raw.includes(v), "a credential reached disk");
    }
    assert.ok(!raw.includes("BEGIN PRIVATE KEY"));
  });

  test("the chain verifies", () => {
    const v = log.verifyAudit();
    assert.equal(v.intact, true, JSON.stringify(v));
  });

  test("status and evidence describe the vendor layer", async () => {
    const audit = await import("../src/audit/index.js");
    assert.ok(audit.auditStatus().sees.some((s) => /hosted agents' own audit logs/.test(s)));
    assert.ok(audit.CONTROL_MAP.some((c) => c.iso.startsWith("5.23")));
  });
});
