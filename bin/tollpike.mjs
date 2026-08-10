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
  tollpike mcp            serve the 104 MCP tools over stdio, for an MCP
                          client that spawns a subprocess
  tollpike verify         check the usage ledger's tamper-evident hash chain
  tollpike verify --seal  retro-seal rows that predate the chain (writes a .bak)
  tollpike where          print the paths and URLs this install resolves to
  tollpike --version      print the version
  tollpike --help         this text

FIRST RUN
  1. tollpike                          start it
  2. open http://127.0.0.1:20128/panel  the control panel
  3. add a provider key on the Providers page, or put one in
     ${path.join(HOME, ".env")}

ENVIRONMENT
  PORT                 listen port (default 20128)
  BIND_HOST            listen address (default 127.0.0.1, loopback only)
  TOLLPIKE_ENV_FILE    read credentials from this file and nothing else
  TOLLPIKE_DATA_DIR    where usage.jsonl and settings.json live
  TOLLPIKE_SECRET      enables AES-256-GCM encryption of the stored gateway key

  Point any OpenAI-compatible client at http://127.0.0.1:20128/v1
`);
}

if (flag("-h", "--help") || cmd === "help") { help(); process.exit(0); }
if (flag("-v", "--version")) { console.log(pkg.version); process.exit(0); }

// A globally installed CLI must not write state inside node_modules: that
// directory is shared between projects and replaced wholesale on upgrade, so
// the usage ledger and settings would be lost on `npm i -g tollpike@next`.
// Credentials already default to ~/.tollpike (see src/env.js), so state joins
// them there. A checkout running `npm start` never goes through this file and
// keeps using ./data exactly as before.
if (!process.env.TOLLPIKE_DATA_DIR) {
  process.env.TOLLPIKE_DATA_DIR = path.join(HOME, "data");
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
if (cmd === "mcp") {
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
