// Environment loading, with the secrets kept outside the project directory.
//
// This replaces a bare `import "dotenv/config"`, which loads `./.env` relative
// to the working directory and nothing else. That put every provider credential
// in a plaintext file inside the source tree — for this install, inside
// `Downloads/`, which is the folder most likely to be zipped, synced to
// cloud storage, attached to a bug report or shared wholesale. The file's ACLs
// were never the weak part; its LOCATION was.
//
// TOLLPIKE_ENV_FILE, if set, is AUTHORITATIVE: it is the only file read, and
// neither default below is consulted. Otherwise two files are layered:
//
//   1. ~/.tollpike/.env    the default home for real credentials. Outside the
//                          repo, outside Downloads, and created with inherited
//                          permissions stripped so only the owner and SYSTEM
//                          can read it.
//   2. <package>/.env      the .env beside the package (a checkout, or /app
//                          in the image), deliberately LAST. Docker Compose
//                          mounts one there, CI writes one there. It used to
//                          be ./.env in the working directory, so the global
//                          CLI run inside any project loaded that project's
//                          .env: a cloned repository could point a provider's
//                          base URL, or the data directory, wherever it liked.
//
// dotenv does not overwrite a variable that is already set, so an earlier
// source wins and the layering is free: shared non-secret defaults in the
// repo's .env, real keys in the protected one. A variable already present in
// the real environment beats every file, which is what keeps the systemd unit
// and `docker run -e` working.
//
// Why an explicit path suppresses the defaults rather than merely outranking
// them: it is the only way to get a process that reads NO ambient credentials.
// The e2e suite depends on exactly that — it asserts that no credentialled
// provider is reachable, which is what stops the tests from spending a
// developer's money — and a home-directory file that loads regardless of cwd
// would quietly defeat it. "Point it at a path that does not exist" has to
// actually mean no credentials, or the isolation is a comment rather than a
// guarantee.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export const PROTECTED_ENV_DIR = path.join(os.homedir(), ".tollpike");
export const PROTECTED_ENV_FILE = path.join(PROTECTED_ENV_DIR, ".env");
const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function candidates() {
  // Naming a file means that file and nothing else — see the header note.
  if (process.env.TOLLPIKE_ENV_FILE) {
    return [{ path: path.resolve(process.env.TOLLPIKE_ENV_FILE), source: "TOLLPIKE_ENV_FILE" }];
  }
  return [
    { path: PROTECTED_ENV_FILE, source: "protected" },
    { path: path.join(PACKAGE_ROOT, ".env"), source: "project" }
  ];
}

// What was actually loaded, for the startup banner and the diagnostics tool.
// Paths only — never values, and never which variables came from where beyond
// the file that supplied them.
export const loaded = [];

for (const candidate of candidates()) {
  if (!fs.existsSync(candidate.path)) continue;
  // quiet: newer dotenv releases log to stdout, which would corrupt the JSON
  // the hook and MCP stdio commands write there.
  const result = dotenv.config({ path: candidate.path, quiet: true });
  if (result.error) {
    console.error(`[env] could not read ${candidate.path}: ${result.error.message}`);
    continue;
  }
  loaded.push(candidate);
}

// An explicitly configured file that does not exist is a mistake worth saying
// out loud: the alternative is a gateway that starts with no credentials and
// reports every provider as simply "no API key configured".
if (process.env.TOLLPIKE_ENV_FILE && !loaded.some((l) => l.source === "TOLLPIKE_ENV_FILE")) {
  console.warn(`[env] TOLLPIKE_ENV_FILE is set to "${process.env.TOLLPIKE_ENV_FILE}" but that file does not exist`);
}

export function envStatus() {
  return {
    loadedFrom: loaded.map((l) => ({ source: l.source, path: l.path })),
    protectedFile: PROTECTED_ENV_FILE,
    // Presence, never the value.
    secretConfigured: Boolean(process.env.TOLLPIKE_SECRET)
  };
}
