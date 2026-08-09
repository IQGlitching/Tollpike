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

if (cmd !== "start") {
  console.error(`tollpike: unknown command "${cmd}". Try \`tollpike --help\`.`);
  process.exit(1);
}

// pathToFileURL, not a bare path: on Windows an absolute path like
// C:\...\server.js is not a valid ESM specifier and the loader rejects it.
await import(pathToFileURL(path.join(root, "src", "server.js")).href);
