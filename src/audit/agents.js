// Per-agent keys.
//
// One gateway key says "someone authorised called". An audit trail needs
// "which agent called", so each agent gets its own key and every event it
// causes carries its name. That is also what makes access reviewable: the
// agent list is the access list, and revoking one agent does not rotate
// everyone else.
//
// Storage holds a SHA-256 of each key, never the key. The keys are 256 bits
// of randomness, so a fast hash is the right one: there is nothing to
// brute-force, and a slow KDF on every request would only add latency. The
// key itself is shown once, at creation, and is unrecoverable afterwards.
//
// Agent keys are deliberately weaker than the operator's gateway key. They
// reach the model endpoints (/v1, /api/chat, /mcp read-only, /a2a) and
// nothing else: an agent cannot open the control panel, change settings,
// mint keys, or edit the audit configuration that watches it.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../paths.js";
import { hexEqual } from "../security/chain.js";

const agentsPath = path.join(dataDir, "agents.json");
const KEY_PREFIX = "tpa_";
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,47}$/;

let cache = null;
let cacheStamp = null;

// Re-read when the file changes, so a key issued or revoked from the CLI
// takes effect in a running gateway without a restart. A revocation that
// waited for a restart would leave the revoked agent working in between.
function stamp() {
  try {
    const st = fs.statSync(agentsPath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "none";
  }
}

function read() {
  const now = stamp();
  if (cache && now === cacheStamp) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(agentsPath, "utf8"));
    cache = Array.isArray(raw.agents) ? raw : { agents: [] };
  } catch {
    cache = { agents: [] };
  }
  cacheStamp = now;
  return cache;
}

function write(state) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${agentsPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, agentsPath);
  try {
    fs.chmodSync(agentsPath, 0o600);
  } catch {
    /* Windows ACLs do not map onto POSIX modes */
  }
  cache = state;
  cacheStamp = stamp();
}

function hashKey(key) {
  return crypto.createHash("sha256").update(String(key)).digest("hex");
}

// The public view. Never includes keyHash: a hash of a 256-bit key is not
// useful to an attacker, but nothing reads it either, and the rule here is
// that no credential material of any kind leaves the module.
function publicView(a) {
  return { id: a.id, name: a.name, kind: a.kind || "agent", createdAt: a.createdAt, revokedAt: a.revokedAt || null, active: !a.revokedAt, note: a.note || null };
}

// Two kinds of key. An agent key calls models; a sensor key submits endpoint
// telemetry and does nothing else. They are kept apart so an agent can never
// submit the telemetry that is meant to check up on it.
export const KINDS = ["agent", "sensor"];

export function listAgents({ includeRevoked = true } = {}) {
  return read().agents.filter((a) => includeRevoked || !a.revokedAt).map(publicView);
}

/** True once any active agent key exists: model endpoints then require a key. */
export function hasAgentKeys() {
  return read().agents.some((a) => !a.revokedAt && (a.kind || "agent") === "agent");
}

/** True once any active sensor key exists: endpoint ingest then requires a key. */
export function hasSensorKeys() {
  return read().agents.some((a) => !a.revokedAt && a.kind === "sensor");
}

export function validateAgentName(name) {
  const n = String(name ?? "").trim();
  if (!NAME_RE.test(n)) return { ok: false, error: "Agent name must be 1-48 characters: letters, digits, space, '.', '_' or '-', starting with a letter or digit." };
  if (read().agents.some((a) => !a.revokedAt && a.name.toLowerCase() === n.toLowerCase())) {
    return { ok: false, error: `An active agent named "${n}" already exists.` };
  }
  return { ok: true, name: n };
}

/**
 * Create an agent and its key. The key is in the return value and nowhere
 * else, ever: the caller must show it to the operator and drop it.
 */
export function createAgent(name, { note, kind = "agent" } = {}) {
  if (!KINDS.includes(kind)) return { ok: false, error: `kind must be one of: ${KINDS.join(", ")}` };
  const v = validateAgentName(name);
  if (!v.ok) return v;
  const state = read();
  const key = KEY_PREFIX + crypto.randomBytes(32).toString("base64url");
  const agent = {
    id: `${kind === "sensor" ? "sen" : "agt"}_${crypto.randomBytes(6).toString("hex")}`,
    name: v.name,
    kind,
    keyHash: hashKey(key),
    createdAt: new Date().toISOString(),
    revokedAt: null,
    note: note ? String(note).slice(0, 200) : undefined
  };
  write({ agents: [...state.agents, agent] });
  return { ok: true, agent: publicView(agent), key };
}

export function revokeAgent(idOrName) {
  const state = read();
  const target = state.agents.find((a) => !a.revokedAt && (a.id === idOrName || a.name.toLowerCase() === String(idOrName).toLowerCase()));
  if (!target) return { ok: false, error: `No active agent "${idOrName}".` };
  const agents = state.agents.map((a) => (a === target ? { ...a, revokedAt: new Date().toISOString() } : a));
  write({ agents });
  return { ok: true, agent: publicView({ ...target, revokedAt: agents.find((a) => a.id === target.id).revokedAt }) };
}

/**
 * Match a presented token. Returns { agent } for an active key, { revoked }
 * for a revoked one (so the failure can be audited as such), or null.
 * Every stored hash is compared in constant time, and the loop never exits
 * early, so timing does not reveal which entry matched or how many exist.
 */
export function matchAgentKey(token) {
  if (typeof token !== "string" || !token.startsWith(KEY_PREFIX)) return null;
  const presented = hashKey(token);
  let hit = null;
  for (const a of read().agents) {
    if (hexEqual(presented, a.keyHash) && !hit) hit = a;
  }
  if (!hit) return null;
  return hit.revokedAt ? { revoked: publicView(hit) } : { agent: publicView(hit) };
}

/** Tests only: forget the in-memory copy so a test can swap the data dir. */
export function _resetAgentsCache() {
  cache = null;
  cacheStamp = null;
}
