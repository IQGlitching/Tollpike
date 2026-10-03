// Drata.
//
// What Drata's API allows, and therefore what this does:
//
//   tests     Drata has no API to create a test or post a result. Custom
//             tests are built once in the Test Builder over a Custom
//             Connection's records. So Tollpike pushes one record per signal
//             into a custom connection, replacing the whole dataset each time
//             through a session (an atomic swap), and the custom test
//             ("passing = true, or applicable = false") does the rest.
//             Custom Connections need Drata's Advanced or Enterprise plan;
//             without it Drata answers 402 and the push says so.
//   accounts  the agent and sensor key register, as records in a second
//             custom connection (Drata's API cannot create personnel), so a
//             custom test can watch it (optional).
//   evidence  the evidence pack PDF and its JSON, uploaded as evidence
//             files and attached to one evidence item linked to the controls
//             the operator names. The first push creates the item; later
//             pushes add a new artifact version to it, so the history of
//             monthly evidence stays in Drata.
//
// Sources: developers.drata.com V2 OpenAPI spec, the custom connections
// recipe, and help.drata.com articles 6695964, 11995676, 11825614
// (checked 2026-10-03).

import { vendorFetch } from "../vendors/framework.js";
import { textToPdf } from "./pdf.js";

const REGIONS = {
  us: "https://public-api.drata.com/public/v2",
  eu: "https://public-api.eu.drata.com/public/v2",
  apac: "https://public-api.apac.drata.com/public/v2"
};
const DEFAULT_EVIDENCE_NAME = "Tollpike AI agent audit evidence";

function base(config) {
  return process.env.TOLLPIKE_GRC_DRATA_BASE_URL || REGIONS[config.region] || REGIONS.us;
}

function explain(err) {
  if (err.status === 402) return new Error("Drata answered 402: Custom Connections need the Advanced or Enterprise plan.");
  if (err.status === 412) return new Error("Drata answered 412: accept the Drata API terms and conditions in the Drata app first.");
  return err;
}

async function call(config, path, opts = {}) {
  try {
    return await vendorFetch(`${base(config)}${path}`, {
      ...opts,
      headers: { authorization: `Bearer ${process.env.DRATA_API_KEY}`, ...(opts.json ? { "content-type": "application/json" } : {}), ...(opts.headers || {}) },
      body: opts.json ? JSON.stringify(opts.json) : opts.body
    });
  } catch (err) {
    throw explain(err);
  }
}

// Replace a custom connection resource's whole dataset in one session.
async function replaceDataset(config, connectionId, resourceId, records) {
  const sessionId = `tollpike-${Date.now()}`;
  const root = `/custom-connections/${encodeURIComponent(connectionId)}/resources/${encodeURIComponent(resourceId)}/sessions/${sessionId}`;
  try {
    await call(config, root, { method: "POST", json: { data: records } });
    await call(config, `${root}/actions`, { method: "POST", json: { action: "complete" } });
  } catch (err) {
    // Leave no session IN_PROGRESS: Drata allows only one per resource.
    await call(config, `${root}/actions`, { method: "POST", json: { action: "cancel" } }).catch(() => {});
    throw err;
  }
  return records.length;
}

async function uploadFile(config, name, type, content) {
  const form = new FormData();
  form.append("file", new Blob([content], { type }), name);
  const r = await call(config, `/workspaces/${encodeURIComponent(config.workspaceId)}/evidence-files`, { method: "POST", body: form, retries: 1 });
  if (!r.json?.fileKey) throw new Error(`Drata did not return a fileKey for ${name}.`);
  return r.json.fileKey;
}

async function controlIds(config) {
  const codes = String(config.evidenceControlCodes || "").split(",").map((c) => c.trim()).filter(Boolean);
  const ids = [];
  for (const code of codes) {
    // The `code:` prefix is sent literally, as Drata documents it; only the
    // code itself is encoded.
    const ref = /^\d+$/.test(code) ? code : `code:${encodeURIComponent(code)}`;
    const r = await call(config, `/workspaces/${encodeURIComponent(config.workspaceId)}/controls/${ref}`);
    if (r.json?.id !== undefined) ids.push(Number(r.json.id));
  }
  return ids;
}

export const drata = {
  id: "drata",
  name: "Drata",
  description: "Continuous tests and the agent register as Custom Connection records, and the evidence pack attached to controls as evidence.",
  sends: "seven pass/fail signals, the agent and sensor key register (optional), the evidence pack PDF and JSON (optional)",
  limits: "Custom Connections and Tests need Drata's Advanced or Enterprise plan. Custom tests are created once in the Drata Test Builder; there is no API for them. The API key needs Custom Connections Data and Evidence Library: Create Evidence permissions.",
  credentials: [{ env: "DRATA_API_KEY", description: "Drata API key (Settings > API Keys) with Custom Connections Data and Evidence Library permissions" }],
  settings: [
    { key: "workspaceId", description: "Drata workspace id (GET /workspaces)", required: true },
    { key: "region", description: '"us" (default), "eu" or "apac"' },
    { key: "testsConnectionId", description: "Custom connection id for Tollpike tests" },
    { key: "testsResourceId", description: "That connection's resource id (customResources[0].id)" },
    { key: "agentsConnectionId", description: "Custom connection id for the agent key register" },
    { key: "agentsResourceId", description: "That connection's resource id" },
    { key: "evidenceControlCodes", description: "Comma-separated control codes to link the evidence to, e.g. DCF-37,DCF-38" },
    { key: "evidenceName", description: `Name of the evidence item (default "${DEFAULT_EVIDENCE_NAME}")` }
  ],
  defaultIntervalHours: 24,

  async push({ payload, config }) {
    const out = { ok: true, skipped: [] };

    if (config.testsConnectionId && config.testsResourceId) {
      // Flat records; `id` is Drata's upsert key, `name` the display key.
      const records = payload.signals.map((s) => ({
        id: s.id,
        name: s.title,
        status: s.status,
        passing: s.status === "pass",
        applicable: s.status !== "not_applicable",
        detail: s.detail.slice(0, 500),
        controls: s.controls.join(" "),
        measuredAt: s.measuredAt
      }));
      out.tests = await replaceDataset(config, config.testsConnectionId, config.testsResourceId, records);
    } else out.skipped.push("tests: testsConnectionId and testsResourceId not set");

    if (config.agentsConnectionId && config.agentsResourceId) {
      const records = payload.accounts.map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        active: a.active,
        createdAt: a.createdAt,
        revokedAt: a.revokedAt || "",
        human: false
      }));
      out.accounts = await replaceDataset(config, config.agentsConnectionId, config.agentsResourceId, records);
    } else out.skipped.push("accounts: agentsConnectionId and agentsResourceId not set");

    const pdfName = payload.evidence.summary.name.replace(/\.md$/, ".pdf");
    const pdfKey = await uploadFile(config, pdfName, "application/pdf", textToPdf(payload.evidence.summary.content, { title: "Tollpike AI agent audit evidence" }));
    const jsonKey = await uploadFile(config, payload.evidence.json.name, "application/json", payload.evidence.json.content);
    const filedAt = payload.generatedAt.slice(0, 10);
    const artifacts = [
      { artifactName: pdfName, fileKey: pdfKey, filedAt },
      { artifactName: payload.evidence.json.name, fileKey: jsonKey, filedAt }
    ];
    const name = config.evidenceName || DEFAULT_EVIDENCE_NAME;
    const ws = encodeURIComponent(config.workspaceId);
    const ids = await controlIds(config);
    const description = `AI agent audit trail from Tollpike, ${payload.period.from.slice(0, 10)} to ${payload.period.to.slice(0, 10)}. Chain ${payload.evidence.intact ? "intact" : "NOT intact"}, head ${payload.evidence.head}. ${payload.evidence.events} events in the period.`;

    const existing = await call(config, `/workspaces/${ws}/evidence?name=${encodeURIComponent(name)}&size=50`);
    const match = (existing.json?.data || []).find((e) => e.name === name);
    if (match) {
      await call(config, `/workspaces/${ws}/evidence/${encodeURIComponent(match.id)}`, {
        method: "PUT",
        json: { description, ...(ids.length ? { controlIds: ids } : {}), newArtifacts: artifacts.map((a) => ({ artifactType: "S3_FILE", ...a })) }
      });
      out.evidence = { updated: true, evidenceId: match.id, files: 2, controls: ids.length };
    } else {
      const r = await call(config, `/workspaces/${ws}/evidence`, {
        method: "POST",
        json: { name, description, renewalScheduleType: "ONE_MONTH", ...(ids.length ? { controlIds: ids } : {}), artifacts: artifacts.map((a) => ({ type: "S3_FILE", ...a })) }
      });
      // Drata creates the evidence row even when some artifacts fail.
      if (r.json && Number(r.json.artifactsCreated) < Number(r.json.artifactsRequested)) {
        throw new Error(`Drata created the evidence but only ${r.json.artifactsCreated} of ${r.json.artifactsRequested} files attached.`);
      }
      out.evidence = { created: true, evidenceId: r.json?.id, files: 2, controls: ids.length };
    }
    return out;
  }
};
