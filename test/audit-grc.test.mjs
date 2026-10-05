// Pushing audit evidence to Vanta and Drata. One local server plays both
// platforms, answering the documented paths with the documented shapes and
// checking each request the way the platform would. Credentials are test
// values made up here.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tollpike-grc-"));
process.env.TOLLPIKE_DATA_DIR = DATA_DIR;
process.env.TOLLPIKE_ENV_FILE = path.join(DATA_DIR, "no-such.env");
process.env.TOLLPIKE_SECRET = "grc-test-secret";
delete process.env.TOLLPIKE_AUDIT;

const CREDS = {
  VANTA_CLIENT_ID: "test-vanta-build-client",
  VANTA_CLIENT_SECRET: "test-vanta-build-secret-0001",
  VANTA_MANAGE_CLIENT_ID: "test-vanta-manage-client",
  VANTA_MANAGE_CLIENT_SECRET: "test-vanta-manage-secret-0002",
  DRATA_API_KEY: "test-drata-api-key-0003"
};

const seen = { vanta: [], drata: [] };
const world = { vantaReject: false, drataPlan: true, drataEvidence: [], drataPartial: false, sessions: {} };

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}
const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  const raw = await readBody(req);
  const u = new URL(req.url, "http://mock");
  const p = u.pathname;
  const auth = req.headers.authorization || "";
  const ct = req.headers["content-type"] || "";
  const json = () => JSON.parse(raw.toString() || "{}");

  // ---- Vanta ----
  if (p === "/oauth/token") {
    if (!ct.includes("application/json")) return send(res, 400, { message: "token endpoint does not accept form-encoded bodies" });
    const b = json();
    seen.vanta.push({ token: b.scope, client: b.client_id });
    if (b.grant_type !== "client_credentials") return send(res, 400, { error: "unsupported_grant_type" });
    if (b.client_id === CREDS.VANTA_CLIENT_ID && b.client_secret === CREDS.VANTA_CLIENT_SECRET && b.scope === "connectors.self:write-resource") return send(res, 200, { access_token: "vat_build", expires_in: 3600, token_type: "Bearer" });
    if (b.client_id === CREDS.VANTA_MANAGE_CLIENT_ID && b.client_secret === CREDS.VANTA_MANAGE_CLIENT_SECRET && b.scope.includes("vanta-api.documents:upload")) return send(res, 200, { access_token: "vat_manage", expires_in: 3600, token_type: "Bearer" });
    return send(res, 401, { error: "invalid_client" });
  }
  if (p === "/v1/resources/custom_resource" || p === "/v1/resources/user_account") {
    if (auth !== "Bearer vat_build") return send(res, 403, { message: "wrong app" });
    const b = json();
    seen.vanta.push({ put: p, body: b });
    if (world.vantaReject) return send(res, 200, { results: { accepted: 6, rejected: 1 } });
    return send(res, 200, p.endsWith("custom_resource") ? { results: { accepted: b.resources.length, rejected: 0 } } : { success: true });
  }
  if (p === "/v1/documents/doc-ai-logging/uploads") {
    if (auth !== "Bearer vat_manage") return send(res, 403, { message: "needs vanta-api.documents:upload" });
    if (!ct.startsWith("multipart/form-data; boundary=")) return send(res, 415, { message: "unsupported media type" });
    const text = raw.toString("latin1");
    seen.vanta.push({ upload: { pdf: text.includes("%PDF-1.4"), effective: /name="effectiveAtDate"\r\n\r\n(\d{4}-\d{2}-\d{2})/.exec(text)?.[1], filename: /filename="([^"]+)"/.exec(text)?.[1] } });
    return send(res, 201, { id: "upl_1", fileName: "x.pdf" });
  }
  if (p === "/v1/documents/doc-ai-logging/submit") {
    if (auth !== "Bearer vat_manage") return send(res, 403, {});
    seen.vanta.push({ submit: true });
    res.writeHead(204);
    return res.end();
  }

  // ---- Drata (paths under /public/v2 on the real host; the base URL includes it) ----
  if (p.startsWith("/drata")) {
    if (auth !== `Bearer ${CREDS.DRATA_API_KEY}`) return send(res, 401, { name: "Unauthorized", statusCode: 401, message: "Invalid Authorization", code: 0 });
    const dp = p.slice("/drata".length);
    seen.drata.push({ method: req.method, path: dp, ct });
    const sess = dp.match(/^\/custom-connections\/([^/]+)\/resources\/([^/]+)\/sessions\/([A-Za-z0-9_-]{3,64})(\/actions)?$/);
    if (sess) {
      if (!world.drataPlan) return send(res, 402, { name: "PaymentRequired", statusCode: 402, message: "You must upgrade your plan to use this feature", code: 0 });
      const key = `${sess[1]}/${sess[2]}`;
      if (sess[4]) {
        const { action } = json();
        if (action === "complete") world.sessions[key] = world.sessions[`${key}:pending`];
        delete world.sessions[`${key}:pending`];
        return send(res, 200, { sessionId: sess[3], status: action === "complete" ? "ACTIVE" : "CANCELED", action });
      }
      world.sessions[`${key}:pending`] = json().data;
      return send(res, 201, { data: [] });
    }
    if (dp === "/workspaces/7/evidence-files") {
      if (!ct.startsWith("multipart/form-data")) return send(res, 400, { message: "multipart required" });
      const name = /filename="([^"]+)"/.exec(raw.toString("latin1"))?.[1];
      return send(res, 201, { fileKey: `acct/evidence-library/uuid/${name}`, originalFilename: name, mimeType: "x", fileSize: raw.length });
    }
    if (dp === "/workspaces/7/controls/code:DCF-37") return send(res, 200, { id: 3701, code: "DCF-37", name: "Audit logging" });
    if (dp === "/workspaces/7/controls/code:DCF-38") return send(res, 200, { id: 3802, code: "DCF-38", name: "Log review" });
    if (dp === "/workspaces/7/evidence" && req.method === "GET") {
      const name = u.searchParams.get("name");
      return send(res, 200, { data: world.drataEvidence.filter((e) => e.name.startsWith(name)), pagination: { cursor: null } });
    }
    if (dp === "/workspaces/7/evidence" && req.method === "POST") {
      const b = json();
      const e = { id: 555, name: b.name, controlIds: b.controlIds, artifacts: b.artifacts, versions: 1 };
      world.drataEvidence.push(e);
      return send(res, 201, { id: 555, name: b.name, artifactsRequested: b.artifacts.length, artifactsCreated: world.drataPartial ? 1 : b.artifacts.length });
    }
    if (dp === "/workspaces/7/evidence/555" && req.method === "PUT") {
      const b = json();
      const e = world.drataEvidence.find((x) => x.id === 555);
      e.versions += 1;
      e.lastPut = b;
      return send(res, 200, { id: 555 });
    }
    return send(res, 404, { name: "NotFound", statusCode: 404, message: `mock has no route ${dp}`, code: 0 });
  }
  send(res, 404, { message: "no route" });
});

let grc;
let log;
let settings;
let audit;
before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.TOLLPIKE_GRC_VANTA_BASE_URL = base;
  process.env.TOLLPIKE_GRC_DRATA_BASE_URL = `${base}/drata`;
  grc = await import("../src/audit/grc/index.js");
  log = await import("../src/audit/log.js");
  settings = await import("../src/storage/settings.js");
  audit = await import("../src/audit/index.js");
  const agents = await import("../src/audit/agents.js");
  agents.createAgent("claude-code-ci");
  agents.revokeAgent(agents.createAgent("old-bot").agent.id);
});
after(() => server.close());

const configure = (grcPatch) => {
  const cur = settings.getSettings().audit;
  settings.updateSettings({ audit: { ...cur, grc: { ...(cur.grc || {}), ...grcPatch } } });
};
const lastPush = (id) => log.readEvents().filter((e) => e.type === "grc.push" && e.platform === id).at(-1);

describe("continuous tests", () => {
  test("every signal reports, with controls, and nothing passes without data", () => {
    const s = grc.computeSignals();
    assert.equal(s.length, grc.SIGNAL_CATALOG.length);
    for (const x of s) {
      assert.ok(["pass", "fail", "not_applicable"].includes(x.status), x.id);
      assert.ok(x.controls.length && x.detail, x.id);
    }
    const by = Object.fromEntries(s.map((x) => [x.id, x]));
    assert.equal(by["audit.egress_enforced"].status, "not_applicable");
    assert.equal(by["audit.vendor_collection"].status, "not_applicable");
    assert.equal(by["audit.chain_keyed"].status, "pass");
  });

  test("attribution fails on an anonymous model call and passes when all are attributed", async () => {
    const { runWithContext } = await import("../src/audit/context.js");
    runWithContext({ source: "openai", agent: { id: "agt_x", name: "x" } }, () => audit.recordModelCall({ model: "m", messages: [] }, { choices: [{ message: { content: "ok" } }] }));
    assert.equal(grc.computeSignals().find((x) => x.id === "audit.agents_attributed").status, "pass");
    runWithContext({ source: "openai", agent: null }, () => audit.recordModelCall({ model: "m", messages: [] }, { choices: [{ message: { content: "ok" } }] }));
    const a = grc.computeSignals().find((x) => x.id === "audit.agents_attributed");
    assert.equal(a.status, "fail");
    assert.equal(a.metrics.unattributed, 1);
    runWithContext({ source: "openai", agent: { id: "operator", name: "operator" } }, () => audit.recordModelCall({ model: "m", messages: [] }, { choices: [{ message: { content: "ok" } }] }));
    audit.recordModelCall({ model: "m", messages: [] }, { choices: [{ message: { content: "ok" } }] });
    assert.equal(grc.computeSignals().find((x) => x.id === "audit.agents_attributed").metrics.unattributed, 3, "the operator key and an in-process call are not agent identities");
  });

  test("the review backlog fails when a flag outlives the allowed days", async () => {
    const { runWithContext } = await import("../src/audit/context.js");
    runWithContext({ source: "openai", agent: { id: "a", name: "a" } }, () =>
      audit.recordModelCall({ model: "m", messages: [] }, { choices: [{ message: { tool_calls: [{ id: "c", function: { name: "bash", arguments: '{"command":"rm -rf /"}' } }] } }] })
    );
    assert.equal(grc.computeSignals({ reviewDays: 7 }).find((x) => x.id === "audit.review_backlog").status, "pass");
    assert.equal(grc.computeSignals({ reviewDays: 0 }).find((x) => x.id === "audit.review_backlog").status, "fail");
  });

  test("a gateway bypass seen by a sensor fails the egress test", async () => {
    const ep = await import("../src/audit/endpoint/index.js");
    ep.ingestEndpoint({ format: "native", host: "dev-1", sensor: "s", body: [{ kind: "dns", pid: 9, image: "chrome.exe", query: "api.openai.com" }] });
    assert.equal(grc.computeSignals().find((x) => x.id === "audit.egress_enforced").status, "fail");
  });

  test("a broken chain fails the integrity test", () => {
    const original = fs.readFileSync(log.logPath, "utf8");
    const lines = original.trim().split("\n");
    lines[0] = lines[0].replace('"type":"', '"type":"x');
    fs.writeFileSync(log.logPath, lines.join("\n") + "\n");
    assert.equal(grc.computeSignals().find((x) => x.id === "audit.chain_intact").status, "fail");
    fs.writeFileSync(log.logPath, original);
    assert.equal(grc.computeSignals().find((x) => x.id === "audit.chain_intact").status, "pass");
  });
});

describe("configuration", () => {
  test("an unconfigured platform says what is missing and sends nothing", async () => {
    const before = seen.vanta.length;
    const r = await grc.pushGrc("vanta");
    assert.equal(r.ok, false);
    assert.match(r.error, /env VANTA_CLIENT_ID/);
    assert.equal(seen.vanta.length, before);
  });

  test("platform settings refuse credentials and unknown keys", () => {
    const cat = grc.grcCatalog();
    assert.equal(settings.validateAudit({ grc: { vanta: { testsResourceId: "vat_abcdefgh" } } }, null, null, cat).ok, false);
    assert.equal(settings.validateAudit({ grc: { vanta: { clientSecret: "x" } } }, null, null, cat).ok, false);
    assert.equal(settings.validateAudit({ grc: { nope: {} } }, null, null, cat).ok, false);
    assert.equal(settings.validateAudit({ grc: { drata: { workspaceId: "7", evidenceControlCodes: "DCF-37,DCF-38", intervalHours: 24 } } }, null, null, cat).ok, true);
  });
});

describe("Vanta", () => {
  before(() => {
    Object.assign(process.env, CREDS);
    configure({ vanta: { testsResourceId: "res_tollpike_tests", accountsResourceId: "res_users", documentId: "doc-ai-logging" } });
  });

  test("tests sync as flat custom-resource records with one token per app", async () => {
    const r = await grc.pushGrc("vanta");
    assert.equal(r.ok, true, r.error);
    assert.equal(r.tests, 7);
    const put = seen.vanta.find((x) => x.put === "/v1/resources/custom_resource");
    assert.equal(put.body.resourceId, "res_tollpike_tests");
    assert.equal(put.body.resources.length, 7);
    for (const rec of put.body.resources) {
      assert.match(rec.externalUrl, /^https:\/\//);
      assert.ok(rec.uniqueId && rec.displayName);
      for (const v of Object.values(rec.customProperties)) assert.notEqual(typeof v, "object", "properties must be flat");
      assert.equal(rec.customProperties.passing, rec.customProperties.status === "pass");
    }
    const scopes = seen.vanta.filter((x) => x.token).map((x) => x.token);
    assert.ok(scopes.includes("connectors.self:write-resource"));
    assert.ok(scopes.some((s) => s.includes("vanta-api.documents:upload")));
  });

  test("agent keys sync as non-human user accounts", () => {
    const put = seen.vanta.find((x) => x.put === "/v1/resources/user_account");
    const accounts = put.body.resources;
    assert.equal(accounts.length, 2);
    for (const a of accounts) {
      assert.match(a.email, /@agents\.tollpike\.invalid$/);
      assert.equal(a.authMethod, "TOKEN");
      assert.match(a.roleDescription, /non-human/);
    }
    assert.ok(accounts.some((a) => a.status === "DEACTIVATED" && a.deactivatedTimestamp));
  });

  test("the evidence pack is uploaded as a PDF and submitted", () => {
    const up = seen.vanta.find((x) => x.upload).upload;
    assert.equal(up.pdf, true);
    assert.match(up.effective, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(up.filename, /\.pdf$/);
    assert.ok(seen.vanta.some((x) => x.submit));
    assert.equal(lastPush("vanta").outcome, "ok");
  });

  test("a rejected record fails the push and the failure is flagged on the record", async () => {
    world.vantaReject = true;
    const r = await grc.pushGrc("vanta");
    world.vantaReject = false;
    assert.equal(r.ok, false);
    assert.match(r.error, /rejected 1/);
    const e = lastPush("vanta");
    assert.equal(e.outcome, "failed");
    assert.equal(e.flagged, true);
  });

  test("without optional settings the push says what it skipped", async () => {
    configure({ vanta: { testsResourceId: "res_tollpike_tests" } });
    const r = await grc.pushGrc("vanta");
    assert.equal(r.ok, true);
    assert.ok(r.skipped.some((s) => s.startsWith("accounts")));
    assert.ok(r.skipped.some((s) => s.startsWith("evidence")));
  });
});

describe("Drata", () => {
  before(() => {
    configure({ drata: { workspaceId: "7", testsConnectionId: "cc1", testsResourceId: "r1", agentsConnectionId: "cc2", agentsResourceId: "r2", evidenceControlCodes: "DCF-37,DCF-38" } });
  });

  test("tests and agents replace their datasets through completed sessions", async () => {
    const r = await grc.pushGrc("drata");
    assert.equal(r.ok, true, r.error);
    assert.equal(r.tests, 7);
    assert.equal(r.accounts, 2);
    assert.equal(world.sessions["cc1/r1"].length, 7);
    assert.ok(world.sessions["cc1/r1"].every((x) => x.id && typeof x.passing === "boolean"));
    assert.equal(world.sessions["cc2/r2"].find((x) => x.name === "old-bot").active, false);
  });

  test("evidence is uploaded as PDF and JSON, created once and linked to the named controls", () => {
    const e = world.drataEvidence[0];
    assert.equal(e.artifacts.length, 2);
    assert.ok(e.artifacts.every((a) => a.type === "S3_FILE" && a.fileKey.startsWith("acct/evidence-library/") && a.filedAt));
    assert.ok(e.artifacts.some((a) => a.artifactName.endsWith(".pdf")));
    assert.deepEqual(e.controlIds, [3701, 3802]);
    assert.equal(seen.drata.filter((x) => x.path === "/workspaces/7/evidence-files").length, 2);
  });

  test("the next push adds a new artifact version to the same evidence", async () => {
    const r = await grc.pushGrc("drata");
    assert.equal(r.ok, true, r.error);
    assert.equal(r.evidence.updated, true);
    const e = world.drataEvidence[0];
    assert.equal(world.drataEvidence.length, 1);
    assert.equal(e.versions, 2);
    assert.equal(e.lastPut.newArtifacts.length, 2);
    assert.ok(e.lastPut.newArtifacts.every((a) => a.artifactType === "S3_FILE"));
  });

  test("a plan without Custom Connections is explained, and no session is left open", async () => {
    world.drataPlan = false;
    const r = await grc.pushGrc("drata");
    world.drataPlan = true;
    assert.equal(r.ok, false);
    assert.match(r.error, /Advanced or Enterprise/);
    assert.equal(Object.keys(world.sessions).filter((k) => k.endsWith(":pending")).length, 0);
  });

  test("evidence created with missing files is reported as a failure", async () => {
    world.drataEvidence = [];
    world.drataPartial = true;
    const r = await grc.pushGrc("drata");
    world.drataPartial = false;
    assert.equal(r.ok, false);
    assert.match(r.error, /only 1 of 2 files/);
  });
});

describe("integrity", () => {
  test("no credential reached the record, and the chain verifies", () => {
    const raw = fs.readFileSync(log.logPath, "utf8");
    for (const [k, v] of Object.entries(CREDS)) {
      if (k.endsWith("CLIENT_ID")) continue; // identifiers, not secrets
      assert.ok(!raw.includes(v), `${k} reached the audit log`);
    }
    assert.equal(log.verifyAudit().intact, true);
  });
});
