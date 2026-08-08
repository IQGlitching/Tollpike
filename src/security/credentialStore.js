// Writing a provider credential to the protected env file, from the panel.
//
// The audit moved credentials OUT of the project tree for a reason that has
// not changed: `data/` lives under Downloads, which is the folder most likely
// to be zipped, synced to cloud storage or attached to a bug report. So a key
// typed into the panel goes to exactly the file `env.js` already reads —
// `~/.tollpike/.env`, or whatever `TOLLPIKE_ENV_FILE` names — and nowhere else.
// Nothing here ever writes a credential under the repo.
//
// Three properties this file is responsible for:
//
//   1. The variable NAME is never caller-supplied. Callers pass a provider id;
//      the name comes from that provider's `apiKeyEnv` in the registry. Without
//      that, "set a key" becomes "write an arbitrary variable", and the first
//      interesting target is TOLLPIKE_SECRET — the one value that makes every
//      encrypted field on disk recoverable.
//   2. A value can never break out of its line. A newline in the value would
//      append a second assignment, which is the same hole by another route.
//   3. The file's permissions survive the write. Writing a temp file and
//      renaming is the only crash-safe way to do this, but on Windows the
//      renamed file carries the TEMP file's ACL — so the hardening is
//      re-applied after every write rather than assumed to have been inherited.
//
// Values are never logged, never returned to a caller, and never echoed in an
// error message.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PROTECTED_ENV_DIR, PROTECTED_ENV_FILE } from "../env.js";

// Same resolution as env.js: an explicitly named file is authoritative, which
// is what keeps the e2e suite's no-real-credentials guard honest — it points
// TOLLPIKE_ENV_FILE at a scratch path, and writes must land there too.
export function credentialFile() {
  return process.env.TOLLPIKE_ENV_FILE
    ? path.resolve(process.env.TOLLPIKE_ENV_FILE)
    : PROTECTED_ENV_FILE;
}

const VALID_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_VALUE = 8192;

// Names this path must never write, whatever the caller thinks it is doing.
// Today the only caller derives the name from a provider's `apiKeyEnv`, so
// none of these is reachable — but "the caller is careful" is not a control,
// and the blast radius here is total: TOLLPIKE_SECRET decrypts every field
// this gateway has ever written, and NODE_OPTIONS is arbitrary code on the
// next restart.
const RESERVED = new Set([
  "TOLLPIKE_SECRET", "TOLLPIKE_ENV_FILE", "TOLLPIKE_DATA_DIR",
  "PATH", "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD"
]);

export function validateEnvName(name) {
  return typeof name === "string" && VALID_NAME.test(name) && !RESERVED.has(name);
}

// What a credential may contain. Deliberately permissive about the alphabet —
// provider keys are base64url, hex, JWTs, dotted, prefixed, and comma-joined
// for multi-connection lanes — and deliberately strict about anything that
// changes the shape of the file.
export function validateCredential(value) {
  if (typeof value !== "string") return "credential must be a string";
  const v = value.trim();
  if (!v) return "credential is empty";
  if (v.length > MAX_VALUE) return `credential is longer than ${MAX_VALUE} characters`;
  // eslint-disable-next-line no-control-regex
  if (/[\r\n\0]/.test(v)) return "credential contains a line break or null byte";
  return null;
}

// dotenv reads bare values up to the first `#`, so anything with a comment
// marker, whitespace or a quote has to be quoted to survive a round trip.
function serializeValue(value) {
  if (/^[A-Za-z0-9_\-./:+=,@]*$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function assignmentMatcher(name) {
  // Tolerates `export FOO=`, leading whitespace and `FOO =`, which dotenv
  // accepts and which a hand-edited file is likely to contain.
  return new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`);
}

function hardenPermissions(file, dir) {
  try {
    fs.chmodSync(file, 0o600);
  } catch { /* Windows ACLs don't map onto POSIX modes; handled below */ }
  if (process.platform !== "win32") return;
  // Re-assert after every write: rename gives the file the temp file's ACL,
  // so "it was hardened when we created it" is not a property that survives.
  try {
    const user = process.env.USERNAME
      ? `${process.env.USERDOMAIN || os.hostname()}\\${process.env.USERNAME}`
      : null;
    const grants = ["SYSTEM:(F)"];
    if (user) grants.unshift(`${user}:(F)`);
    execFileSync("icacls", [file, "/inheritance:r", "/grant:r", ...grants], {
      stdio: "ignore",
      timeout: 10_000
    });
    if (dir) execFileSync("icacls", [dir, "/inheritance:r", "/grant:r", ...grants], { stdio: "ignore", timeout: 10_000 });
  } catch { /* best effort — a readable file is better than a failed save */ }
}

function readLines(file) {
  if (!fs.existsSync(file)) return { lines: [], existed: false, eol: os.EOL };
  const raw = fs.readFileSync(file, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  // Trailing newline produces a trailing "" — dropped here and restored on
  // write, so a file does not gain a blank line on every save.
  const lines = raw.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return { lines, existed: true, eol };
}

function writeLines(file, lines, eol) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, lines.join(eol) + eol, { mode: 0o600 });
  fs.renameSync(tmp, file);
  hardenPermissions(file, dir === PROTECTED_ENV_DIR ? dir : null);
}

// Upsert. Returns { file, created } and never the value.
export function setCredential(name, value) {
  if (!validateEnvName(name)) throw new Error("invalid environment variable name");
  const problem = validateCredential(value);
  if (problem) throw new Error(problem);

  const file = credentialFile();
  const { lines, existed, eol } = readLines(file);
  const trimmed = value.trim();
  const line = `${name}=${serializeValue(trimmed)}`;
  const matcher = assignmentMatcher(name);

  let replaced = false;
  const next = lines.map((l) => {
    if (replaced || !matcher.test(l)) return l;
    replaced = true;
    return line;
  });
  if (!replaced) {
    // A file written by hand may not end with a blank line; keep one between
    // whatever was there and the appended block so the result reads cleanly.
    if (next.length && next[next.length - 1].trim() !== "") next.push("");
    next.push(line);
  }
  writeLines(file, next, eol);
  return { file, created: !existed, replaced };
}

// Removes every assignment of `name`. Returns how many lines went.
export function clearCredential(name) {
  if (!validateEnvName(name)) throw new Error("invalid environment variable name");
  const file = credentialFile();
  const { lines, existed, eol } = readLines(file);
  if (!existed) return { file, removed: 0 };
  const matcher = assignmentMatcher(name);
  const next = lines.filter((l) => !matcher.test(l));
  const removed = lines.length - next.length;
  if (removed) writeLines(file, next, eol);
  return { file, removed };
}

// Presence and shape only — never the value. This is what the panel is
// allowed to know about a credential that is already set.
export function credentialStatus(name) {
  const value = process.env[name];
  if (!value) return { set: false, connections: 0, hint: null };
  const parts = value.split(",").map((k) => k.trim()).filter(Boolean);
  const first = parts[0] || "";
  return {
    set: true,
    connections: parts.length,
    // Enough to recognise which key is installed, not enough to use it.
    hint: first.length <= 8 ? `${"•".repeat(first.length)}` : `${first.slice(0, 3)}…${first.slice(-4)}`
  };
}

// Whether the file we would write to is the hardened one, so the panel can
// say so rather than implying a guarantee it cannot check.
export function storageLocation() {
  const file = credentialFile();
  return {
    file,
    protected: file === PROTECTED_ENV_FILE,
    insideProject: path.resolve(file).startsWith(path.resolve(process.cwd()) + path.sep),
    exists: fs.existsSync(file)
  };
}
