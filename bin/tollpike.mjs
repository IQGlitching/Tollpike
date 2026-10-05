#!/usr/bin/env node
// Tollpike CLI.
//
// A thin wrapper around src/server.js. It exists to do one thing the module
// itself must not do: decide where state lives when Tollpike is installed
// globally rather than cloned.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const argv = process.argv.slice(2);
const flag = (...names) => names.some((n) => argv.includes(n));
const cmd = argv.find((a) => !a.startsWith("-")) || "start";

const HOME = path.join(os.homedir(), ".tollpike");

function help() {
  console.log(`
tollpike ${pkg.version}
Routing infrastructure for AI. One endpoint, every provider behind it.

USAGE
  tollpike [start]        start the gateway and the control panel
  tollpike panel          open the control panel in your browser, unlocked
  tollpike key            print the operator key the control panel needs
  tollpike key rotate     replace the operator key (open panels must unlock again)
  tollpike mcp            serve the 112 MCP tools over stdio, for an MCP
                          client that spawns a subprocess
  tollpike verify         check the usage ledger's tamper-evident hash chain
  tollpike verify --seal  retro-seal rows that predate the chain (writes a .bak)
  tollpike agents add N   issue an agent key (shown once); keys become mandatory
  tollpike agents list    the agent key register
  tollpike agents revoke  revoke an agent's key by id or name
  tollpike audit          audit coverage, gaps and rule modes
  tollpike audit events   recent audit events (--flagged, --unreviewed, --agent, --type)
  tollpike audit verify   check the audit log's tamper-evident hash chain
  tollpike audit review   sign off a flagged event (--by <name> --note <text>)
  tollpike audit export   evidence pack for an auditor (--from, --to, --out)
  tollpike audit egress-hosts  provider hosts to block for everyone but Tollpike
  tollpike audit vendors  hosted-agent audit-log connectors (pull <id> to fetch now)
  tollpike audit grc      compliance tests and Vanta/Drata push (setup <id>, push <id>)
  tollpike hook config    print the Claude Code hooks block (--command, --fail-closed)
  tollpike hook claude-code  forward one Claude Code hook event (run by the hook)
  tollpike mcp-proxy      audited MCP proxy over stdio (--check to test servers)
  tollpike agents add N --sensor  issue a sensor key for an endpoint collector
  tollpike endpoint sysmon   ship Sysmon events (Windows) to the gateway
  tollpike endpoint tail F --format auditd|osquery|falco  follow a sensor log
  tollpike endpoint snapshot send the current process list
  tollpike where          print the paths and URLs this install resolves to
  tollpike --version      print the version
  tollpike --help         this text

FIRST RUN
  1. tollpike                          start it (creates the operator key)
  2. tollpike panel                    open the control panel, unlocked
  3. add a provider key on the Providers page, or put one in
     ${path.join(HOME, ".env")}

ENVIRONMENT
  PORT                 listen port (default 20128)
  BIND_HOST            listen address (default 127.0.0.1, loopback only)
  TOLLPIKE_ENV_FILE    read credentials from this file and nothing else
  TOLLPIKE_DATA_DIR    where usage.jsonl and settings.json live
  TOLLPIKE_SECRET      enables AES-256-GCM encryption of the stored gateway key
                       and keys the ledger and audit hash chains
  TOLLPIKE_AUDIT       set to off to stop recording the audit trail

  Point any OpenAI-compatible client at http://127.0.0.1:20128/v1
`);
}

if (flag("-h", "--help") || cmd === "help") { help(); process.exit(0); }
if (flag("-v", "--version")) { console.log(pkg.version); process.exit(0); }

// Load ~/.tollpike/.env (or TOLLPIKE_ENV_FILE) before any command, exactly as
// the gateway does. TOLLPIKE_SECRET usually lives there, and it keys the audit
// and ledger chains: a CLI command that ran without it would verify a keyed
// chain as an unkeyed one and call it tampered, and a command that writes
// (audit review, agents add, grc push) would append rows the gateway's key
// does not sign, which really would break the chain.
await import(pathToFileURL(path.join(root, "src", "env.js")).href);

// A globally installed CLI must not write state inside node_modules: that
// directory is shared between projects and replaced wholesale on upgrade, so
// the usage ledger and settings would be lost on `npm i -g tollpike@next`.
// Credentials already default to ~/.tollpike (see src/env.js), so state joins
// them there. A checkout running `npm start` never goes through this file and
// keeps using ./data exactly as before.
if (!process.env.TOLLPIKE_DATA_DIR) {
  process.env.TOLLPIKE_DATA_DIR = path.join(HOME, "data");
}

// The operator key. The gateway creates it on first start; these commands
// create it too if the gateway has never run, so `tollpike key` always has an
// answer. The key is printed only here, on the operator's own terminal, never
// by the gateway into its logs.
if (cmd === "key" || cmd === "panel") {
  const settings = await import(pathToFileURL(path.join(root, "src", "storage", "settings.js")).href);
  const sub = argv[argv.indexOf(cmd) + 1];
  const made = settings.ensureOperatorKey();
  if (made.unreadable) {
    console.error("The operator key cannot be decrypted. Set TOLLPIKE_SECRET to the value used when it was written.");
    process.exit(1);
  }
  const port = process.env.PORT || 20128;
  const host = process.env.BIND_HOST && process.env.BIND_HOST !== "0.0.0.0" ? process.env.BIND_HOST : "127.0.0.1";
  const base = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;

  if (cmd === "key" && sub === "rotate") {
    const { generateApiKey } = await import(pathToFileURL(path.join(root, "src", "security", "crypto.js")).href);
    settings.updateSettings({ gatewayApiKey: generateApiKey() });
    console.log("Operator key replaced. Open panels must unlock again: run tollpike panel.");
    console.log(`Anything that sent the old key (scripts, Authorization headers) needs the new one: tollpike key`);
    process.exit(0);
  }
  if (cmd === "key") {
    console.log(settings.getSettings().gatewayApiKey);
    if (process.stdout.isTTY) console.error(settings.isKeyEncryptedAtRest() ? "(stored encrypted)" : "(stored in cleartext: set TOLLPIKE_SECRET to encrypt it)");
    process.exit(0);
  }

  // tollpike panel: ask the running gateway for a one-time code, then open the
  // panel with it. The browser trades the code for the key, so the key never
  // appears in a URL or in browser history.
  let code;
  try {
    const res = await fetch(`${base}/api/panel/login-code`, {
      method: "POST",
      headers: { authorization: `Bearer ${settings.getSettings().gatewayApiKey}`, "content-type": "application/json" },
      body: "{}"
    });
    if (!res.ok) throw new Error(`the gateway answered ${res.status}`);
    code = (await res.json()).code;
  } catch (err) {
    console.error(`Could not reach the gateway at ${base} (${err.cause?.code || err.message}). Start it with: tollpike`);
    process.exit(1);
  }
  const url = `${base}/panel/#code=${code}`;
  const { spawn } = await import("node:child_process");
  const opener = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(opener[0], opener[1], { stdio: "ignore", detached: true }).unref();
    console.log(`Opening the control panel. The link works once, for 60 seconds.`);
  } catch {
    console.log(`Open this link within 60 seconds (it works once):\n  ${url}`);
  }
  process.exit(0);
}

if (cmd === "where") {
  const port = process.env.PORT || 20128;
  const host = process.env.BIND_HOST || "127.0.0.1";
  console.log(`version       ${pkg.version}
install       ${root}
data dir      ${process.env.TOLLPIKE_DATA_DIR}
env file      ${process.env.TOLLPIKE_ENV_FILE || path.join(HOME, ".env") + "  then  " + path.resolve(process.cwd(), ".env")}
control panel http://${host}:${port}/panel
api base      http://${host}:${port}/v1`);
  process.exit(0);
}

// Verify the tamper-evident hash chain over the usage ledger without starting
// the gateway. pathToFileURL, not a bare path: on Windows an absolute path is
// not a valid ESM specifier and the loader throws (the recurring bug here).
if (cmd === "verify") {
  const { verifyLedger, sealLedger } = await import(
    pathToFileURL(path.join(root, "src", "storage", "costTracker.js")).href
  );
  const dir = process.env.TOLLPIKE_DATA_DIR;

  // Opt-in backfill: seal a ledger that predates the chain so its pre-chain
  // rows become verifiable too. Rewrites real spend history, so it is never
  // implicit; typing --seal is the confirmation, and it leaves a .bak behind.
  if (flag("--seal")) {
    const s = sealLedger();
    if (!s.ok) {
      if (s.reason === "verification-failed") {
        console.error("refusing to seal: the ledger already fails verification.");
        console.error("run `tollpike verify` to see why. Sealing would overwrite the evidence.");
        process.exit(2);
      }
      if (s.reason === "unparsable-lines") {
        console.error(`refusing to seal: ${s.unparsable} unparsable line(s) in the ledger. Remove or fix them first.`);
        process.exit(2);
      }
      console.error(`seal failed: ${s.error || s.reason}`);
      process.exit(1);
    }
    if (s.sealed === 0) {
      console.log(`nothing to seal: all ${s.total} row(s) are already chained.`);
      process.exit(0);
    }
    console.log(`sealed ${s.sealed} previously unchained row(s).`);
    console.log(`the ledger is now one ${s.keyed ? "keyed" : "unkeyed"} chain of ${s.total} row(s).`);
    console.log(`backup        ${s.backup}`);
    process.exit(0);
  }

  const r = verifyLedger();
  console.log(`ledger        ${path.join(dir, "usage.jsonl")}`);
  console.log(
    `sealing       ${
      r.keyed
        ? "keyed (HMAC-SHA256 under TOLLPIKE_SECRET)"
        : "unkeyed (SHA-256), set TOLLPIKE_SECRET for tamper-evidence"
    }`
  );
  console.log(`rows          ${r.total} total, ${r.chained} chained, ${r.unchained} pre-chain`);
  if (r.chainOk === null) {
    console.log("status        nothing sealed yet, the chain begins at the next recorded request");
    process.exit(0);
  }
  if (r.intact) {
    console.log("status        OK, every chained row verifies");
    process.exit(0);
  }
  const problems = [];
  if (r.brokenLinks > 0) problems.push(`${r.brokenLinks} row(s) altered (index ${r.brokenAt.join(", ")})`);
  if (r.truncated) problems.push("recent rows deleted (ledger shorter than its anchor)");
  if (r.rolledBack) problems.push("the tail was replaced with a different history");
  if (r.anchorOk === false) problems.push("the anchor does not verify");
  console.log(`status        TAMPERED, ${problems.join("; ")}`);
  process.exit(2);
}

// The audit trail and the agent key register, from the terminal. These run in
// their own process next to a possibly running gateway; both files they touch
// re-read their state when another process has written, so that is safe.
if (cmd === "audit" || cmd === "agents") {
  const audit = await import(pathToFileURL(path.join(root, "src", "audit", "index.js")).href);
  const agents = await import(pathToFileURL(path.join(root, "src", "audit", "agents.js")).href);
  const VALUE_FLAGS = ["--from", "--to", "--type", "--agent", "--tool", "--severity", "--limit", "--by", "--note", "--out"];
  const opts = {};
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    if (VALUE_FLAGS.includes(argv[i])) opts[argv[i].slice(2)] = argv[++i];
    else if (!argv[i].startsWith("-")) words.push(argv[i]);
  }
  const sub = words[1] || (cmd === "agents" ? "list" : "status");
  const json = flag("--json");
  const out = (obj, text) => console.log(json ? JSON.stringify(obj, null, 2) : text());

  if (cmd === "agents") {
    if (sub === "list") {
      const list = agents.listAgents();
      out({ agents: list }, () =>
        list.length
          ? list
              .map((a) => `${a.active ? "active " : "revoked"}  ${a.kind.padEnd(6)} ${a.id}  ${a.name.padEnd(24)} created ${a.createdAt}${a.revokedAt ? `  revoked ${a.revokedAt}` : ""}`)
              .join("\n")
          : "no agent keys issued. Create one: tollpike agents add <name>"
      );
      process.exit(0);
    }
    if (sub === "add") {
      const r = agents.createAgent(words.slice(2).join(" "), { note: opts.note, kind: flag("--sensor") ? "sensor" : "agent" });
      if (!r.ok) {
        console.error(r.error);
        process.exit(1);
      }
      audit.recordAdmin("agent.created", { target: r.agent, via: "cli" });
      console.log(`agent         ${r.agent.name} (${r.agent.id})`);
      console.log(`key           ${r.key}`);
      console.log("");
      console.log("This key is shown once and cannot be recovered.");
      if (r.agent.kind === "sensor") console.log("Set it as TOLLPIKE_SENSOR_KEY where the collector runs. It can submit endpoint telemetry and nothing else.");
      else {
        console.log("Give it to the agent as its API key.");
        console.log("Model endpoints now require a key: callers without one are refused.");
      }
      process.exit(0);
    }
    if (sub === "revoke") {
      const r = agents.revokeAgent(words.slice(2).join(" "));
      if (!r.ok) {
        console.error(r.error);
        process.exit(1);
      }
      audit.recordAdmin("agent.revoked", { target: r.agent, via: "cli" });
      console.log(`revoked       ${r.agent.name} (${r.agent.id}) at ${r.agent.revokedAt}`);
      process.exit(0);
    }
    console.error(`tollpike: unknown agents command "${sub}". Use list, add <name> or revoke <id|name>.`);
    process.exit(1);
  }

  if (sub === "status") {
    const s = audit.auditStatus();
    out(s, () =>
      [
        `audit         ${s.enabled ? "enabled" : "DISABLED"}, content stored ${s.content === "hash" ? "as hashes only" : "redacted"}`,
        `log           ${s.logPath}`,
        `chain         ${s.chain.total} rows, ${s.chain.intact ? "intact" : "NOT INTACT"}, ${s.chain.keyed ? "keyed" : "unkeyed"}`,
        `agents        ${s.agents.active} active${s.agents.requireKeyOnModelEndpoints ? ", key required on model endpoints" : ""}`,
        `operator key  ${s.operatorKeySet ? "set" : "NOT SET"}`,
        "",
        "gaps",
        ...s.gaps.map((g) => `  - ${g}`),
        "",
        "rules",
        ...s.rules.map((r) => `  ${r.mode.padEnd(8)} ${r.severity.padEnd(8)} ${r.id}`)
      ].join("\n")
    );
    process.exit(0);
  }

  if (sub === "verify") {
    const v = audit.verifyAudit();
    const problems = [];
    if (v.brokenLinks) problems.push(`${v.brokenLinks} broken link(s) at row ${v.brokenAt.join(", ")}`);
    if (v.truncated) problems.push("rows deleted");
    if (v.rolledBack) problems.push("tail replaced");
    if (v.anchorOk === false) problems.push("anchor missing or does not verify");
    out(v, () =>
      [
        `log           ${audit.auditStatus().logPath}`,
        `rows          ${v.total}, ${v.algo}${v.keyed ? " (keyed)" : " (unkeyed)"}`,
        `status        ${v.intact ? "OK, every row verifies" : `TAMPERED: ${problems.join("; ")}`}`,
        `head          ${v.head}`,
        v.note
      ].join("\n")
    );
    process.exit(v.intact ? 0 : 2);
  }

  if (sub === "summary") {
    const s = audit.auditSummary({ from: opts.from, to: opts.to });
    console.log(JSON.stringify(s, null, 2));
    process.exit(0);
  }

  if (sub === "events") {
    const r = audit.queryEvents({
      from: opts.from,
      to: opts.to,
      type: opts.type,
      agent: opts.agent,
      tool: opts.tool,
      severity: opts.severity,
      flaggedOnly: flag("--flagged"),
      unreviewedOnly: flag("--unreviewed"),
      limit: opts.limit || 50
    });
    out(r, () => {
      if (!r.events.length) return "no matching events";
      const rows = r.events.map((e) => {
        const what = e.tool || e.action || e.outcome || e.reason || "";
        const findings = (e.findings || []).map((x) => x.rule).join(",");
        const mark = findings ? `  [${e.flagged ? "FLAG " : ""}${findings}]` : "";
        return `${e.ts}  ${e.id}  ${(e.agent?.name || "-").padEnd(16)} ${e.type.padEnd(14)} ${what}${mark}`;
      });
      return `${rows.join("\n")}\n\n${r.returned} of ${r.total} shown`;
    });
    process.exit(0);
  }

  if (sub === "review") {
    const [eventId, decision] = words.slice(2);
    const r = audit.reviewEvent({ eventId, decision, reviewer: opts.by, note: opts.note });
    if (!r.ok) {
      console.error(r.error);
      console.error("usage: tollpike audit review <eventId> <acknowledged|false_positive|escalated|resolved> --by <name> [--note <text>]");
      process.exit(1);
    }
    console.log(`reviewed      ${eventId} as ${decision} by ${opts.by} (${r.review.id})`);
    process.exit(0);
  }

  if (sub === "export") {
    const pack = audit.exportEvidence({ from: opts.from, to: opts.to });
    const dir = path.resolve(opts.out || `tollpike-evidence-${new Date().toISOString().slice(0, 10)}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "evidence.json"), JSON.stringify(pack, null, 2));
    fs.writeFileSync(path.join(dir, "SUMMARY.md"), audit.evidenceMarkdown(pack));
    audit.recordAdmin("evidence.export", { period: pack.period, events: pack.events.length, via: "cli" });
    console.log(`evidence      ${dir}`);
    console.log(`              evidence.json (${pack.events.length} events), SUMMARY.md`);
    console.log(`chain         ${pack.verification.intact ? "intact" : "NOT INTACT"}, head ${pack.verification.head}`);
    process.exit(0);
  }

  if (sub === "vendors") {
    const vendors = await import(pathToFileURL(path.join(root, "src", "audit", "vendors", "index.js")).href);
    const action = words[2] || "list";
    if (action === "pull") {
      const id = words[3];
      const r = await vendors.pullVendor(id);
      if (!r.ok) {
        console.error(`pull failed: ${r.error}`);
        process.exit(1);
      }
      console.log(`${id}: ${r.fetched} fetched, ${r.recorded} recorded, ${r.duplicates} duplicates, ${r.pages} page(s)`);
      process.exit(0);
    }
    const catalog = vendors.connectorCatalog();
    const status = vendors.vendorsStatus();
    if (json) {
      console.log(JSON.stringify({ connectors: catalog, status }, null, 2));
      process.exit(0);
    }
    for (const c of catalog) {
      const s = status.find((x) => x.id === c.id);
      console.log(`${s.configured ? (s.enabled ? "on  " : "idle") : "--  "}  ${c.id.padEnd(18)} ${c.name}`);
      console.log(`        covers   ${c.covers}`);
      console.log(`        needs    ${[...c.credentials.map((x) => `${x.env}${x.optional ? " (optional)" : ""}${process.env[x.env] ? " [set]" : ""}`), ...c.settings.filter((x) => x.required).map((x) => `audit.vendors.${c.id}.${x.key}`)].join(", ")}`);
      if (s.lastPullAt) console.log(`        last     ${s.lastPullAt}`);
    }
    console.log("\non = configured and scheduled, idle = configured but not enabled, -- = missing credentials or settings.");
    console.log("Pull one now: tollpike audit vendors pull <id>");
    process.exit(0);
  }

  if (sub === "grc") {
    const grc = await import(pathToFileURL(path.join(root, "src", "audit", "grc", "index.js")).href);
    const action = words[2] || "status";
    if (action === "push") {
      const r = await grc.pushGrc(words[3]);
      if (!r.ok) {
        console.error(`push failed: ${r.error}`);
        process.exit(1);
      }
      console.log(`${words[3]}: ${r.tests ?? 0} tests, ${r.accounts ?? 0} accounts, evidence ${r.evidence ? JSON.stringify(r.evidence) : "not sent"}`);
      for (const s of r.skipped || []) console.log(`  skipped ${s}`);
      process.exit(0);
    }
    if (action === "setup") {
      const id = words[3];
      if (id === "vanta") {
        const { VANTA_TEST_SCHEMA } = await import(pathToFileURL(path.join(root, "src", "audit", "grc", "vanta.js")).href);
        console.log(`Vanta, one-time setup:

1. Settings > Developer Console > Create > Build Integrations > Private.
   Copy the client id and secret into the gateway's environment:
     VANTA_CLIENT_ID=...   VANTA_CLIENT_SECRET=...
2. In that app's Resources tab, add a Custom Resource named "Tollpike test"
   with this schema, and copy its Resource ID:

${JSON.stringify(VANTA_TEST_SCHEMA, null, 2)}

3. Optional: add a User Account resource too, for agent keys in access reviews.
4. Optional, for evidence uploads: create a Manage Vanta app and set
     VANTA_MANAGE_CLIENT_ID=...   VANTA_MANAGE_CLIENT_SECRET=...
   and pick the evidence document to upload to.
5. Tell Tollpike the ids:
     POST /api/panel/audit/settings
     {"grc": {"vanta": {"enabled": true, "testsResourceId": "...", "accountsResourceId": "...", "documentId": "..."}}}
6. Push once:  tollpike audit grc push vanta
7. Tests > Create custom test > integration "Tollpike" > resource "Tollpike test".
   Rule: passing equals true  OR  applicable equals false.
   Map it to your logging and monitoring controls. Vanta has no API for this step.`);
        process.exit(0);
      }
      if (id === "drata") {
        console.log(`Drata, one-time setup:

1. Settings > API Keys > Create API Key, with Custom Connections Data
   (create and update) and Evidence Library: Create Evidence. Put it in the
   gateway's environment:  DRATA_API_KEY=...
2. Create a custom connection for the tests (Drata API or UI), with these
   record fields: id, name (display key), status, passing (boolean),
   applicable (boolean), detail, controls, measuredAt. Note the connection id
   and customResources[0].id. Custom Connections need Advanced or Enterprise.
3. Optional: a second connection for the agent register, fields id, name,
   kind, active (boolean), createdAt, revokedAt, human (boolean).
4. Tell Tollpike the ids (workspaceId from GET /workspaces):
     POST /api/panel/audit/settings
     {"grc": {"drata": {"enabled": true, "workspaceId": "...", "testsConnectionId": "...",
       "testsResourceId": "...", "evidenceControlCodes": "DCF-37,DCF-38"}}}
5. Push once:  tollpike audit grc push drata
6. Monitoring > Create test > Custom > provider "Tollpike".
   Condition: passing = true  OR  applicable = false. Publish it and map it to
   your logging and monitoring controls. Drata has no API for this step.`);
        process.exit(0);
      }
      console.error("usage: tollpike audit grc setup <vanta|drata>");
      process.exit(1);
    }
    const signals = grc.computeSignals();
    const status = grc.grcStatus();
    if (json) {
      console.log(JSON.stringify({ signals, platforms: status }, null, 2));
      process.exit(0);
    }
    console.log("continuous tests (what Vanta or Drata would show)");
    for (const s of signals) console.log(`  ${s.status === "pass" ? "PASS" : s.status === "fail" ? "FAIL" : "n/a "}  ${s.id.padEnd(24)} ${s.detail}`);
    console.log("\nplatforms");
    const catalog = grc.grcCatalog();
    for (const p of status) {
      const required = (catalog.find((c) => c.id === p.id)?.credentials || []).filter((c) => !c.optional).map((c) => c.env);
      const missing = required.filter((env) => !p.credentials[env]);
      console.log(`  ${p.configured ? (p.enabled ? "on  " : "idle") : "--  "}  ${p.name.padEnd(8)} ${p.configured ? `every ${p.intervalHours}h${p.lastRun ? `, last ${p.lastRun.ok ? "ok" : "failed"}` : ""}` : `needs ${missing.join(", ") || "settings"}`}`);
    }
    console.log("\nSet up:  tollpike audit grc setup <vanta|drata>     Push now:  tollpike audit grc push <id>");
    process.exit(0);
  }

  if (sub === "egress-hosts") {
    const { providerHosts } = await import(pathToFileURL(path.join(root, "src", "audit", "egress.js")).href);
    const hosts = providerHosts();
    if (json) console.log(JSON.stringify(hosts, null, 2));
    else if (flag("--plain")) console.log(hosts.map((h) => h.host).join("\n"));
    else {
      console.log("Block these for every machine except the Tollpike host (docs/audit-egress.md):\n");
      for (const h of hosts) console.log(`${h.host.padEnd(44)} ${h.providers.join(", ")}`);
      console.log(`\n${hosts.length} hosts. --plain prints hostnames only, for a firewall import.`);
    }
    process.exit(0);
  }

  console.error(`tollpike: unknown audit command "${sub}". Use status, verify, events, summary, review, export or egress-hosts.`);
  process.exit(1);
}

// Endpoint collectors. They run on an agent's machine with a sensor key in
// TOLLPIKE_SENSOR_KEY and ship OS telemetry to the gateway.
if (cmd === "endpoint") {
  const collect = await import(pathToFileURL(path.join(root, "src", "audit", "endpoint", "collect.js")).href);
  const words = argv.filter((a, i) => !a.startsWith("-") && !["--url", "--format", "--host", "--interval"].includes(argv[i - 1]));
  const valueOf = (name, fallback) => {
    const i = argv.indexOf(name);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const sub = words[1] || "";
  const url = valueOf("--url", process.env.TOLLPIKE_URL || "http://127.0.0.1:20128");
  const key = process.env.TOLLPIKE_SENSOR_KEY;
  const format = valueOf("--format", "");
  const say = (m) => console.error(`[endpoint] ${m}`);

  const sendSnapshot = async () => {
    const snap = await collect.snapshotProcesses();
    if (!snap.ok) return say(`snapshot failed: ${snap.error}`);
    const r = await collect.sendBatch({ url, key, format: "native", body: snap.events });
    say(r.ok ? `snapshot: ${snap.events.length} processes sent` : `snapshot refused: ${r.error}`);
    return r;
  };

  if (sub === "snapshot") {
    const r = await sendSnapshot();
    process.exit(r?.ok ? 0 : 1);
  }

  if (sub === "send") {
    if (!format) {
      console.error("usage: tollpike endpoint send --format <sysmon|auditd|osquery|falco|native> [file]   (stdin when no file)");
      process.exit(1);
    }
    const file = words[2];
    let body = "";
    if (file && file !== "-") body = fs.readFileSync(file, "utf8");
    else for await (const chunk of process.stdin) body += chunk;
    const r = await collect.sendBatch({ url, key, format, body, host: valueOf("--host", undefined) });
    if (!r.ok) {
      console.error(`refused: ${r.error}`);
      process.exit(1);
    }
    console.log(`received ${r.received}, recorded ${r.recorded}, unexplained ${r.unexplained}, ignored ${r.ignored}, skipped ${r.skipped}`);
    process.exit(0);
  }

  if (sub === "tail") {
    const file = words[2];
    if (!file || !format) {
      console.error("usage: tollpike endpoint tail <file> --format <auditd|osquery|falco|native> [--from-start]");
      process.exit(1);
    }
    await sendSnapshot();
    await collect.tailFile({ file, format, url, key, fromStart: flag("--from-start"), intervalMs: Number(valueOf("--interval", "2")) * 1000, log: say });
  }

  if (sub === "sysmon") {
    if (process.platform !== "win32") {
      console.error("Sysmon is Windows-only. On Linux use: tollpike endpoint tail /var/log/audit/audit.log --format auditd");
      process.exit(1);
    }
    await sendSnapshot();
    const r = await collect.pollSysmon({ url, key, intervalMs: Number(valueOf("--interval", "5")) * 1000, log: say, once: flag("--once") });
    process.exit(r?.ok === false ? 1 : 0);
  }

  console.error("usage: tollpike endpoint snapshot | send --format F [file] | tail <file> --format F | sysmon   (key in TOLLPIKE_SENSOR_KEY)");
  process.exit(1);
}

// Claude Code hook client and config. `tollpike hook claude-code` is what a
// command hook runs: it forwards the event on stdin to the gateway and prints
// the gateway's answer for Claude Code. Its one job beyond forwarding is the
// failure policy. Fail-open by default (the gateway being down must not stop
// work); --fail-closed refuses tool calls while the audit cannot be recorded.
// Nothing is written to stdout except the answer: stdout is what Claude Code
// parses.
if (cmd === "hook") {
  const sub = argv.filter((a) => !a.startsWith("-"))[1] || "";
  const valueOf = (name, fallback) => {
    const i = argv.indexOf(name);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const url = valueOf("--url", process.env.TOLLPIKE_URL || "http://127.0.0.1:20128");

  if (sub === "config") {
    const { claudeCodeHookConfig } = await import(pathToFileURL(path.join(root, "src", "audit", "hooks.js")).href);
    console.log(JSON.stringify(claudeCodeHookConfig({ url, mode: flag("--command") ? "command" : "http", failClosed: flag("--fail-closed") }), null, 2));
    process.exit(0);
  }

  if (sub === "claude-code") {
    const failClosed = flag("--fail-closed");
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    let event = "";
    try {
      event = JSON.parse(raw).hook_event_name || "";
    } catch {
      // forwarded as-is; the gateway answers 400 and the policy below applies
    }
    const refuse = (why) => {
      // Exit 2 blocks a PreToolUse and feeds stderr to Claude. Any other event
      // has nothing to block, so the failure is reported and work continues.
      if (failClosed && (event === "PreToolUse" || event === "UserPromptSubmit")) {
        console.error(`Tollpike audit could not record this action (${why}). Blocked because the hook is fail-closed.`);
        process.exit(2);
      }
      console.error(`tollpike hook: ${why}; continuing unaudited (fail-open).`);
      process.exit(0);
    };
    try {
      const res = await fetch(`${url.replace(/\/+$/, "")}/audit/hooks/claude-code`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(process.env.TOLLPIKE_AGENT_KEY ? { authorization: `Bearer ${process.env.TOLLPIKE_AGENT_KEY}` } : {})
        },
        body: raw,
        signal: AbortSignal.timeout(Number(valueOf("--timeout", "10")) * 1000)
      });
      const text = await res.text();
      if (!res.ok) refuse(`gateway answered HTTP ${res.status}`);
      process.stdout.write(text || "{}");
      process.exit(0);
    } catch (err) {
      refuse(err.name === "TimeoutError" ? "gateway timed out" : `gateway unreachable: ${err.cause?.code || err.message}`);
    }
  }

  console.error("usage: tollpike hook claude-code [--url U] [--fail-closed]   (run by a Claude Code command hook)");
  console.error("       tollpike hook config [--url U] [--command] [--fail-closed]   (print the settings.json hooks block)");
  process.exit(1);
}

// The MCP proxy over stdio, for an agent that spawns its MCP servers. The
// agent spawns this instead; this spawns the real servers from mcp-proxy.json
// and records every call. Identity comes from TOLLPIKE_AGENT_KEY, checked
// against the local agent register. stdout is the protocol stream.
if (cmd === "mcp-proxy") {
  const proxy = await import(pathToFileURL(path.join(root, "src", "audit", "mcpProxy.js")).href);
  const agentsMod = await import(pathToFileURL(path.join(root, "src", "audit", "agents.js")).href);
  const cfg = proxy.loadProxyConfig();
  if (!cfg.ok) {
    console.error(`tollpike mcp-proxy: ${cfg.error}`);
    process.exit(1);
  }

  if (flag("--check")) {
    const hub = new proxy.ProxyHub(cfg.servers);
    const tools = await hub.listTools();
    console.log(`config        ${cfg.file}${cfg.missing ? " (not found: no servers)" : ""}`);
    for (const s of hub.status()) console.log(`${s.connected ? "ok  " : "FAIL"}  ${s.name.padEnd(16)} ${s.kind.padEnd(5)} ${s.target}  ${s.connected ? `${s.tools} tools` : s.error}`);
    console.log(`tools         ${tools.length} exposed: ${tools.map((t) => t.name).slice(0, 20).join(", ")}${tools.length > 20 ? ", ..." : ""}`);
    await hub.close();
    process.exit(0);
  }

  let agent = null;
  const presented = process.env.TOLLPIKE_AGENT_KEY;
  const match = presented ? agentsMod.matchAgentKey(presented) : null;
  if (match?.agent) agent = { id: match.agent.id, name: match.agent.name };
  else if (presented || agentsMod.hasAgentKeys()) {
    console.error(`tollpike mcp-proxy: ${match?.revoked ? "this agent key has been revoked" : presented ? "TOLLPIKE_AGENT_KEY is not a valid agent key" : "agent keys are in use, so TOLLPIKE_AGENT_KEY must be set"}.`);
    process.exit(1);
  }
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const hub = new proxy.ProxyHub(cfg.servers);
  const server = proxy.createProxyServer(hub, { context: { source: "mcp-proxy", agent, callerId: agent ? `agent:${agent.id}` : "anonymous" } });
  await server.connect(new StdioServerTransport());
  const shutdown = async () => {
    await hub.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("end", shutdown);
  console.error(`[mcp-proxy] ready on stdio, ${Object.keys(cfg.servers).length} downstream server(s), agent ${agent ? agent.name : "unattributed"}`);
}

// The MCP stdio transport, reachable from an install. The README documented
// it as `node src/mcp/server.js`, which is a path only a source checkout has:
// anyone who followed `npx tollpike` or `npm install -g tollpike` had no way
// to point a client at it.
//
// startMcpServer() is called rather than relying on that module's
// main-module guard, which compares against process.argv[1] and so is false
// whenever the module is imported by this file instead of run directly.
//
// Nothing may be written to stdout from here on: on this path stdout is the
// JSON-RPC stream itself.
if (cmd === "mcp-proxy") {
  // started above; the stdio transport keeps the process alive
} else if (cmd === "mcp") {
  const { startMcpServer } = await import(
    pathToFileURL(path.join(root, "src", "mcp", "server.js")).href
  );
  await startMcpServer();
} else {
  if (cmd !== "start") {
    console.error(`tollpike: unknown command "${cmd}". Try \`tollpike --help\`.`);
    process.exit(1);
  }
  // pathToFileURL, not a bare path: on Windows an absolute path like
  // C:\...\server.js is not a valid ESM specifier and the loader rejects it.
  await import(pathToFileURL(path.join(root, "src", "server.js")).href);
}
