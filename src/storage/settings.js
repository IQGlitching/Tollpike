import fs from "node:fs";
import path from "node:path";
import { encrypt, decrypt, isEncryptionAvailable } from "../security/crypto.js";
import { dataDir } from "../paths.js";
import { COMPRESSION_DEFAULTS, CAVEMAN_LEVELS, CAVEMAN_SCOPES } from "../compression/compress.js";

const settingsPath = path.join(dataDir, "settings.json");

const DEFAULTS = {
  disabledProviders: [], // provider ids toggled off from the control panel
  budgetCapsUsd: {}, // { providerId: monthlyCapUsd }
  gatewayApiKey: null, // if set, /v1/* and /api/* require Authorization: Bearer <key>
  proxies: {}, // { "*": "http://host:port" } global, or { providerId: url } per-provider
  proxyCategories: {}, // { frontier: url } — level 2 of proxy resolution
  tlsProfile: "default", // outbound TLS fingerprint shaping; see routing/tls.js
  compression: COMPRESSION_DEFAULTS, // see compression/compress.js
  combos: {}, // saved tiered routing combos; see routing/strategies.js
  defaultCombo: null, // combo used for a bare "auto"; null = priority order
  quotaTracking: true, // free-tier accounting; see storage/quotaTracker.js
  memory: {
    enabled: false, // changes the prompt the model sees — opt in explicitly
    recall: "hybrid", // keyword | vector | hybrid
    topK: 6,
    crossSession: false, // recall is caller-partitioned by default, like the cache
    qdrantUrl: null,
    collection: "tollpike-memory",
    embeddingProvider: null, // any OpenAI-compatible provider with /embeddings
    embeddingModel: null
  },
  knowledge: { notion: false, obsidianVault: null },
  gamification: true
};

export function validateCompression(patch = {}) {
  const next = {};
  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
  if (patch.historyWindow !== undefined) {
    const n = Number(patch.historyWindow);
    if (!Number.isInteger(n) || n < 1 || n > 500) {
      return { ok: false, error: "historyWindow must be an integer between 1 and 500" };
    }
    next.historyWindow = n;
  }

  if (patch.rtk !== undefined) {
    if (typeof patch.rtk !== "object" || patch.rtk === null) {
      return { ok: false, error: "rtk must be an object" };
    }
    const rtkPatch = {};
    for (const flag of ["enabled", "tabularize", "runs", "blobs", "whitespace", "dictionary"]) {
      if (patch.rtk[flag] !== undefined) rtkPatch[flag] = Boolean(patch.rtk[flag]);
    }
    if (patch.rtk.maxBlobChars !== undefined) {
      const n = Number(patch.rtk.maxBlobChars);
      if (!Number.isInteger(n) || n < 16 || n > 100_000) {
        return { ok: false, error: "rtk.maxBlobChars must be an integer between 16 and 100000" };
      }
      rtkPatch.maxBlobChars = n;
    }
    next.rtk = rtkPatch;
  }

  if (patch.caveman !== undefined) {
    if (typeof patch.caveman !== "object" || patch.caveman === null) {
      return { ok: false, error: "caveman must be an object" };
    }
    const cavemanPatch = {};
    if (patch.caveman.enabled !== undefined) cavemanPatch.enabled = Boolean(patch.caveman.enabled);
    if (patch.caveman.level !== undefined) {
      if (!CAVEMAN_LEVELS.includes(patch.caveman.level)) {
        return { ok: false, error: `caveman.level must be one of ${CAVEMAN_LEVELS.join(", ")}` };
      }
      cavemanPatch.level = patch.caveman.level;
    }
    if (patch.caveman.scope !== undefined) {
      if (!CAVEMAN_SCOPES.includes(patch.caveman.scope)) {
        return { ok: false, error: `caveman.scope must be one of ${CAVEMAN_SCOPES.join(", ")}` };
      }
      cavemanPatch.scope = patch.caveman.scope;
    }
    next.caveman = cavemanPatch;
  }

  return { ok: true, value: next };
}

// The gateway key is the one credential this file holds. crypto.js existed
// from the start but nothing ever called it: the key was written in
// plaintext while the panel displayed "Key encryption at rest: active"
// whenever TOLLPIKE_SECRET was set. That is the same false-confidence
// failure the no-hardcoded-fallback invariant exists to prevent, just one
// layer up — so the key is now actually encrypted when a secret is set.
const ENCRYPTED_FIELDS = ["gatewayApiKey"];

function ensureDir() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
}

function readRaw() {
  ensureDir();
  if (!fs.existsSync(settingsPath)) return { ...DEFAULTS };
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch (err) {
    // A corrupt settings file must not brick the gateway. Fall back to
    // defaults (auth stays on if it can't be read? no — it can't be read,
    // so it can't be trusted) and keep the bad file for inspection.
    console.error(`[settings] unreadable settings.json (${err.message}); using defaults`);
    return { ...DEFAULTS };
  }
}

// Non-atomic writeFileSync left a window where a crash or a concurrent
// panel write truncated the file. Write to a temp file in the same
// directory and rename — rename is atomic on POSIX and on NTFS.
function writeAtomic(value) {
  ensureDir();
  const tmp = `${settingsPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, settingsPath);
  try {
    fs.chmodSync(settingsPath, 0o600); // settings hold the gateway key
  } catch {
    /* best effort — Windows ACLs don't map cleanly onto POSIX modes */
  }
}

function decodeStored(onDisk) {
  const out = { ...onDisk };
  for (const field of ENCRYPTED_FIELDS) {
    const v = out[field];
    if (v && typeof v === "object" && v.encrypted === true) {
      try {
        out[field] = decrypt(v);
      } catch (err) {
        // Wrong or missing TOLLPIKE_SECRET. Failing closed here would lock
        // the operator out permanently with no way back in; failing open
        // would silently disable auth. Surface it loudly and treat the
        // gateway as locked with an unusable key.
        console.error(`[settings] cannot decrypt ${field}: ${err.message}`);
        out[field] = null;
      }
    }
  }
  return out;
}

function encodeForDisk(value) {
  const out = { ...value };
  for (const field of ENCRYPTED_FIELDS) {
    const v = out[field];
    if (typeof v === "string" && v.length > 0 && isEncryptionAvailable()) {
      out[field] = encrypt(v);
    }
  }
  return out;
}

export function getSettings() {
  const stored = decodeStored(readRaw());
  const storedCompression = stored.compression || {};
  return {
    ...DEFAULTS,
    ...stored,
    // Nested defaults would otherwise be replaced wholesale by a partial
    // object on disk, so a settings file written before this field existed
    // would read back as `{}` rather than the documented defaults. Every
    // nested group needs this, one level per group — the compression layers
    // are two deep, and a file written before RTK existed must still read
    // back with RTK's defaults rather than `undefined` for every flag.
    compression: {
      ...DEFAULTS.compression,
      ...storedCompression,
      rtk: { ...DEFAULTS.compression.rtk, ...(storedCompression.rtk || {}) },
      caveman: { ...DEFAULTS.compression.caveman, ...(storedCompression.caveman || {}) }
    },
    memory: { ...DEFAULTS.memory, ...(stored.memory || {}) },
    knowledge: { ...DEFAULTS.knowledge, ...(stored.knowledge || {}) }
  };
}

export function updateSettings(patch) {
  const next = { ...getSettings(), ...patch };
  writeAtomic(encodeForDisk(next));
  return next;
}

// True only when the stored key is actually encrypted on disk, so the panel
// can report the real state instead of "is a secret configured".
export function isKeyEncryptedAtRest() {
  const raw = readRaw();
  const v = raw.gatewayApiKey;
  return Boolean(v && typeof v === "object" && v.encrypted === true);
}

export function isProviderDisabled(providerId) {
  return getSettings().disabledProviders.includes(providerId);
}

export function toggleProvider(providerId, enabled) {
  const settings = getSettings();
  const disabled = new Set(settings.disabledProviders);
  if (enabled) disabled.delete(providerId);
  else disabled.add(providerId);
  return updateSettings({ disabledProviders: [...disabled] });
}

// `Number(capUsd)` used to accept anything: a typo became NaN, which
// serialized to JSON null, which read back as "no cap" — silently removing
// the control the operator thought they had just set. Reject bad input at
// the boundary instead.
export function validateBudgetCap(capUsd) {
  if (capUsd === null || capUsd === undefined || capUsd === "") return { ok: true, value: null };
  const n = typeof capUsd === "number" ? capUsd : Number(capUsd);
  if (!Number.isFinite(n)) {
    return { ok: false, error: "capUsd must be a finite number, or null to clear the cap" };
  }
  if (n < 0) {
    return { ok: false, error: "capUsd must not be negative (a negative cap blocks the provider permanently)" };
  }
  return { ok: true, value: n };
}

export function setBudgetCap(providerId, capUsd) {
  const parsed = validateBudgetCap(capUsd);
  if (!parsed.ok) throw Object.assign(new Error(parsed.error), { status: 400 });

  const settings = getSettings();
  const caps = { ...settings.budgetCapsUsd };
  if (parsed.value === null) delete caps[providerId];
  else caps[providerId] = parsed.value;
  return updateSettings({ budgetCapsUsd: caps });
}
