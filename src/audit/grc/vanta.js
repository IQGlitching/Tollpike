// Vanta.
//
// What Vanta's API allows, and therefore what this does:
//
//   tests     Vanta has no API to create a test or set its result. Tests are
//             Custom Tests the customer builds once in the UI over a custom
//             resource. So Tollpike syncs one custom-resource record per
//             signal (signals.js) through a private Build Integrations app,
//             and the Custom Test rule ("passing is true, or applicable is
//             false") turns each into a live pass/fail. The sync is
//             full-state: every push replaces the last.
//   accounts  the agent and sensor key register, synced as User Accounts so
//             agent identities appear in access reviews (optional).
//   evidence  the evidence pack as a PDF, uploaded to an evidence document
//             and submitted (optional). Document uploads belong to the
//             Manage Vanta API, a different app type in Vanta, so they need
//             their own client id and secret.
//
// Vanta allows one live token per app, and minting a new one revokes the
// old, so tokens are cached per app and pushes never run concurrently (the
// framework enforces one at a time).
//
// Sources: developer.vanta.com, the manage-vanta.json and
// build-integrations.json OpenAPI specs (checked 2026-10-03).

import { vendorFetch } from "../vendors/framework.js";
import { textToPdf } from "./pdf.js";

const DEFAULT_BASE = "https://api.vanta.com";
const GOV_BASE = "https://api.vanta-gov.com";
const DEFAULT_URL = "https://iqglitching.github.io/Tollpike/#audit";
const tokens = new Map();

function base(config) {
  return process.env.TOLLPIKE_GRC_VANTA_BASE_URL || (config.region === "gov" ? GOV_BASE : DEFAULT_BASE);
}

async function token(config, clientId, clientSecret, scope) {
  const key = `${clientId}|${scope}`;
  const hit = tokens.get(key);
  if (hit && hit.expiresAt - 60_000 > Date.now()) return hit.token;
  // JSON body: Vanta's token endpoint does not accept form encoding.
  const r = await vendorFetch(`${base(config)}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, scope, grant_type: "client_credentials" }),
    retries: 1
  });
  if (!r.json?.access_token) throw new Error("Vanta token endpoint returned no access_token.");
  tokens.set(key, { token: r.json.access_token, expiresAt: Date.now() + (Number(r.json.expires_in) || 3600) * 1000 });
  return r.json.access_token;
}

function httpsUrl(config) {
  const u = String(config.externalUrl || "");
  return /^https:\/\//.test(u) ? u : DEFAULT_URL;
}

// Accept both documented shapes: {success:true} and {results:{accepted,rejected}}.
function syncResult(json, what) {
  if (json?.results && Number(json.results.rejected) > 0) throw new Error(`Vanta rejected ${json.results.rejected} ${what} record(s).`);
  if (json && json.success === false) throw new Error(`Vanta did not accept the ${what} sync.`);
  return json?.results?.accepted;
}

export const vanta = {
  id: "vanta",
  name: "Vanta",
  description: "Continuous tests as a custom resource, agent keys as user accounts, and the evidence pack uploaded to an evidence document.",
  sends: "seven pass/fail signals, the agent and sensor key register (optional), the evidence pack PDF (optional)",
  limits: "Custom resources and Custom Tests need a private Build Integrations app; Vanta notes Custom Tests may need a plan upgrade or add-on. Access reviews may need Access Management. Tests are created once in the Vanta UI; there is no API for them.",
  credentials: [
    { env: "VANTA_CLIENT_ID", description: "Private Build Integrations app client id (scopes connectors.self:write-resource)" },
    { env: "VANTA_CLIENT_SECRET", description: "That app's client secret" },
    { env: "VANTA_MANAGE_CLIENT_ID", description: "Manage Vanta app client id, for evidence uploads", optional: true },
    { env: "VANTA_MANAGE_CLIENT_SECRET", description: "That app's client secret", optional: true }
  ],
  settings: [
    { key: "testsResourceId", description: "Resource ID of the custom resource registered for Tollpike tests (Developer Console > your app > Resources)", required: true },
    { key: "accountsResourceId", description: "Resource ID of a User Account resource, to sync agent keys for access reviews" },
    { key: "documentId", description: "Evidence document id to upload the evidence pack to (needs the Manage Vanta credentials)" },
    { key: "externalUrl", description: "HTTPS link shown on each record (defaults to the Tollpike audit docs)" },
    { key: "region", description: '"gov" for Vanta Gov tenants; everyone else, including EU and AU, uses the default' }
  ],
  defaultIntervalHours: 24,

  async push({ payload, config }) {
    const out = { ok: true, skipped: [] };
    const url = httpsUrl(config);
    const build = await token(config, process.env.VANTA_CLIENT_ID, process.env.VANTA_CLIENT_SECRET, "connectors.self:write-resource");
    const headers = { authorization: `Bearer ${build}`, "content-type": "application/json" };

    // Custom-resource properties must be flat: boolean, int32, string, timestamp.
    const tests = payload.signals.map((s) => ({
      displayName: s.title,
      uniqueId: s.id,
      externalUrl: url,
      customProperties: {
        signalId: s.id,
        status: s.status,
        passing: s.status === "pass",
        applicable: s.status !== "not_applicable",
        detail: s.detail.slice(0, 500),
        controls: s.controls.join(" "),
        measuredAt: s.measuredAt
      }
    }));
    const r = await vendorFetch(`${base(config)}/v1/resources/custom_resource`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ resourceId: config.testsResourceId, resources: tests })
    });
    syncResult(r.json, "test");
    out.tests = tests.length;

    if (config.accountsResourceId) {
      const accounts = payload.accounts.map((a) => ({
        displayName: a.name,
        uniqueId: a.id,
        externalUrl: url,
        fullName: `${a.name} (Tollpike ${a.kind})`,
        accountName: a.name,
        // Vanta requires an email; an agent has none. The reserved .invalid
        // TLD can never be delivered to, and says plainly this is not a person.
        email: `${a.id}@agents.tollpike.invalid`,
        createdTimestamp: a.createdAt,
        deactivatedTimestamp: a.revokedAt || undefined,
        mfaEnabled: null,
        mfaMethods: ["UNSUPPORTED"],
        authMethod: "TOKEN",
        permissionLevel: "BASE",
        status: a.active ? "ACTIVE" : "DEACTIVATED",
        roleDescription: a.kind === "sensor" ? "Tollpike sensor key: submits endpoint telemetry only (non-human)" : "Tollpike agent key: model endpoints only (non-human)"
      }));
      const ra = await vendorFetch(`${base(config)}/v1/resources/user_account`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ resourceId: config.accountsResourceId, resources: accounts })
      });
      syncResult(ra.json, "account");
      out.accounts = accounts.length;
    } else out.skipped.push("accounts: no accountsResourceId set");

    if (config.documentId && process.env.VANTA_MANAGE_CLIENT_ID && process.env.VANTA_MANAGE_CLIENT_SECRET) {
      const manage = await token(config, process.env.VANTA_MANAGE_CLIENT_ID, process.env.VANTA_MANAGE_CLIENT_SECRET, "vanta-api.all:read vanta-api.all:write vanta-api.documents:upload");
      const pdf = textToPdf(payload.evidence.summary.content, { title: "Tollpike AI agent audit evidence" });
      const form = new FormData();
      form.append("file", new Blob([pdf], { type: "application/pdf" }), payload.evidence.summary.name.replace(/\.md$/, ".pdf"));
      form.append("effectiveAtDate", payload.generatedAt.slice(0, 10));
      form.append("description", `Tollpike AI agent audit evidence, ${payload.period.from.slice(0, 10)} to ${payload.period.to.slice(0, 10)}. Chain ${payload.evidence.intact ? "intact" : "NOT intact"}, head ${payload.evidence.head}.`);
      const docBase = `${base(config)}/v1/documents/${encodeURIComponent(config.documentId)}`;
      // No content-type header: fetch sets the multipart boundary (a manual one gets 415).
      await vendorFetch(`${docBase}/uploads`, { method: "POST", headers: { authorization: `Bearer ${manage}` }, body: form, retries: 1 });
      await vendorFetch(`${docBase}/submit`, { method: "POST", headers: { authorization: `Bearer ${manage}` }, retries: 1 });
      out.evidence = { uploaded: true, file: payload.evidence.summary.name.replace(/\.md$/, ".pdf"), documentId: config.documentId };
    } else {
      out.skipped.push(config.documentId ? "evidence: Manage Vanta credentials not set" : "evidence: no documentId set");
    }
    return out;
  }
};

/** The custom-resource schema to paste into Vanta (JSON Type Definition). */
export const VANTA_TEST_SCHEMA = {
  properties: {
    signalId: { type: "string" },
    status: { type: "string" },
    passing: { type: "boolean" },
    applicable: { type: "boolean" },
    detail: { type: "string" },
    controls: { type: "string" },
    measuredAt: { type: "timestamp" }
  }
};

export function _resetVantaTokens() {
  tokens.clear();
}
