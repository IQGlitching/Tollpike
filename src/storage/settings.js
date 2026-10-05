import fs from "node:fs";
import path from "node:path";
import { encrypt, decrypt, isEncryptionAvailable, generateApiKey } from "../security/crypto.js";
import { dataDir } from "../paths.js";
import { COMPRESSION_DEFAULTS, CAVEMAN_LEVELS, CAVEMAN_SCOPES } from "../compression/compress.js";

const settingsPath = path.join(dataDir, "settings.json");

const DEFAULTS = {
  disabledProviders: [], // provider ids toggled off from the control panel
  budgetCapsUsd: {}, // { providerId: monthlyCapUsd }
  gatewayApiKey: null, // the operator key; created on first start (ensureOperatorKey) and always required by the control plane
  modelAuth: null, // "local": model endpoints take keyless calls from this machine; "required": they need a key; null: derived (see modelKeyRequired)
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
  gamification: true,
  // Agent audit trail; see src/audit. On by default: it records metadata and
  // redacted previews, never raw content.
  audit: {
    enabled: true,
    content: "redacted", // redacted | hash
    retentionDays: 365, // declared retention, reported in evidence exports
    ruleModes: {}, // { ruleId: "observe" | "flag" | "ask" | "block" }
    disabledRules: [],
    allowedDomains: [], // empty = no domain allowlist rule
    agentProcesses: [], // extra agent runtimes: [{ name, image?, commandLine? }] (regex strings)
    gatewayHosts: [], // hosts allowed to reach providers directly (this host always is)
    vendors: {}, // { connectorId: { enabled, intervalMinutes, ...connector settings } }; credentials live in env only
    grc: {}, // { platformId: { enabled, intervalHours, periodDays, ...platform settings } }; credentials live in env only
    grcReviewDays: 7 // the review-backlog test fails when a flag has waited longer than this
  }
};

const AUDIT_CONTENT = ["redacted", "hash"];
const AUDIT_MODES = ["observe", "flag", "ask", "block"];

// Validates a partial audit patch. Rule ids are checked by the caller that
// knows the rule catalog (audit/rules.js), to keep this module free of an
// import from the audit layer, which itself imports settings.
export function validateAudit(patch = {}, knownRules = null, vendorCatalog = null, grcCatalog = null) {
  const next = {};
  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
  if (patch.content !== undefined) {
    if (!AUDIT_CONTENT.includes(patch.content)) return { ok: false, error: `content must be one of: ${AUDIT_CONTENT.join(", ")}` };
    next.content = patch.content;
  }
  if (patch.retentionDays !== undefined) {
    const n = Number(patch.retentionDays);
    if (!Number.isInteger(n) || n < 30 || n > 3650) return { ok: false, error: "retentionDays must be an integer between 30 and 3650" };
    next.retentionDays = n;
  }
  if (patch.ruleModes !== undefined) {
    if (!patch.ruleModes || typeof patch.ruleModes !== "object" || Array.isArray(patch.ruleModes)) return { ok: false, error: "ruleModes must be an object of ruleId -> mode" };
    for (const [id, mode] of Object.entries(patch.ruleModes)) {
      if (knownRules && !knownRules.includes(id)) return { ok: false, error: `unknown rule "${id}"` };
      if (!AUDIT_MODES.includes(mode)) return { ok: false, error: `mode for ${id} must be one of: ${AUDIT_MODES.join(", ")}` };
    }
    next.ruleModes = { ...patch.ruleModes };
  }
  if (patch.disabledRules !== undefined) {
    if (!Array.isArray(patch.disabledRules)) return { ok: false, error: "disabledRules must be an array of rule ids" };
    for (const id of patch.disabledRules) if (knownRules && !knownRules.includes(id)) return { ok: false, error: `unknown rule "${id}"` };
    next.disabledRules = [...new Set(patch.disabledRules.map(String))];
  }
  if (patch.allowedDomains !== undefined) {
    if (!Array.isArray(patch.allowedDomains) || patch.allowedDomains.length > 500) return { ok: false, error: "allowedDomains must be an array of up to 500 domains" };
    const clean = [];
    for (const d of patch.allowedDomains) {
      const v = String(d).trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
      if (!/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/.test(v)) return { ok: false, error: `"${d}" is not a domain` };
      clean.push(v);
    }
    next.allowedDomains = [...new Set(clean)];
  }
  if (patch.agentProcesses !== undefined) {
    if (!Array.isArray(patch.agentProcesses) || patch.agentProcesses.length > 50) return { ok: false, error: "agentProcesses must be an array of up to 50 { name, image?, commandLine? }" };
    const clean = [];
    for (const r of patch.agentProcesses) {
      if (!r || typeof r.name !== "string" || !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(r.name)) return { ok: false, error: "each agentProcesses entry needs a name of 1-32 letters, digits, '-' or '_'" };
      if (!r.image && !r.commandLine) return { ok: false, error: `agentProcesses "${r.name}" needs an image or commandLine pattern` };
      for (const k of ["image", "commandLine"]) {
        if (r[k] === undefined) continue;
        if (typeof r[k] !== "string" || r[k].length > 200) return { ok: false, error: `agentProcesses "${r.name}": ${k} must be a regex string up to 200 characters` };
        try {
          new RegExp(r[k], "i");
        } catch {
          return { ok: false, error: `agentProcesses "${r.name}": ${k} is not a valid regex` };
        }
      }
      clean.push({ name: r.name, ...(r.image ? { image: r.image } : {}), ...(r.commandLine ? { commandLine: r.commandLine } : {}) });
    }
    next.agentProcesses = clean;
  }
  if (patch.vendors !== undefined) {
    if (!patch.vendors || typeof patch.vendors !== "object" || Array.isArray(patch.vendors)) return { ok: false, error: "vendors must be an object of connectorId -> settings" };
    const out = {};
    for (const [id, v] of Object.entries(patch.vendors)) {
      const known = vendorCatalog ? vendorCatalog.find((c) => c.id === id) : null;
      if (vendorCatalog && !known) return { ok: false, error: `unknown vendor connector "${id}"` };
      if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: `vendors.${id} must be an object` };
      const allowed = new Set(["enabled", "intervalMinutes", ...(known ? known.settings.map((s) => s.key) : [])]);
      const entry = {};
      for (const [k, val] of Object.entries(v)) {
        if (!allowed.has(k)) return { ok: false, error: `vendors.${id}.${k} is not a setting of this connector${known ? ` (settings: ${[...allowed].join(", ")})` : ""}` };
        if (k === "enabled") entry.enabled = Boolean(val);
        else if (k === "intervalMinutes") {
          const n = Number(val);
          if (!Number.isInteger(n) || n < 5 || n > 1440) return { ok: false, error: `vendors.${id}.intervalMinutes must be an integer between 5 and 1440` };
          entry.intervalMinutes = n;
        } else {
          // Identifiers only (tenant, org, workspace). Never a credential:
          // those are read from the environment, so nothing here looks like one.
          if (typeof val !== "string" || !/^[A-Za-z0-9._@:\/,-]{1,200}$/.test(val)) return { ok: false, error: `vendors.${id}.${k} must be an identifier or a comma-separated list (letters, digits, . _ @ : / , -)` };
          if (/^(sk-|tpk_|tpa_|ghp_|github_pat_|xox|AKIA)/.test(val)) return { ok: false, error: `vendors.${id}.${k} looks like a credential. Credentials go in the environment, not in settings.` };
          entry[k] = val;
        }
      }
      out[id] = entry;
    }
    next.vendors = out;
  }
  if (patch.grc !== undefined) {
    if (!patch.grc || typeof patch.grc !== "object" || Array.isArray(patch.grc)) return { ok: false, error: "grc must be an object of platformId -> settings" };
    const out = {};
    for (const [id, v] of Object.entries(patch.grc)) {
      const known = grcCatalog ? grcCatalog.find((c) => c.id === id) : null;
      if (grcCatalog && !known) return { ok: false, error: `unknown compliance platform "${id}"` };
      if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: `grc.${id} must be an object` };
      const allowed = new Set(["enabled", "intervalHours", "periodDays", ...(known ? known.settings.map((x) => x.key) : [])]);
      const entry = {};
      for (const [k, val] of Object.entries(v)) {
        if (!allowed.has(k)) return { ok: false, error: `grc.${id}.${k} is not a setting of this platform${known ? ` (settings: ${[...allowed].join(", ")})` : ""}` };
        if (k === "enabled") entry.enabled = Boolean(val);
        else if (k === "intervalHours" || k === "periodDays") {
          const n = Number(val);
          const [lo, hi] = k === "intervalHours" ? [1, 744] : [1, 366];
          if (!Number.isInteger(n) || n < lo || n > hi) return { ok: false, error: `grc.${id}.${k} must be an integer between ${lo} and ${hi}` };
          entry[k] = n;
        } else {
          if (typeof val !== "string" || !/^[A-Za-z0-9._@:\/, -]{1,200}$/.test(val)) return { ok: false, error: `grc.${id}.${k} must be an identifier (letters, digits, space, . _ @ : / , -)` };
          if (/^(sk-|tpk_|tpa_|ghp_|github_pat_|xox|AKIA|vat_|drata_)/i.test(val)) return { ok: false, error: `grc.${id}.${k} looks like a credential. Credentials go in the environment, not in settings.` };
          entry[k] = val;
        }
      }
      out[id] = entry;
    }
    next.grc = out;
  }
  if (patch.grcReviewDays !== undefined) {
    const n = Number(patch.grcReviewDays);
    if (!Number.isInteger(n) || n < 1 || n > 90) return { ok: false, error: "grcReviewDays must be an integer between 1 and 90" };
    next.grcReviewDays = n;
  }
  if (patch.gatewayHosts !== undefined) {
    if (!Array.isArray(patch.gatewayHosts) || patch.gatewayHosts.length > 50 || patch.gatewayHosts.some((h) => typeof h !== "string" || !/^[A-Za-z0-9.-]{1,253}$/.test(h))) {
      return { ok: false, error: "gatewayHosts must be an array of up to 50 host names" };
    }
    next.gatewayHosts = [...new Set(patch.gatewayHosts.map((h) => h.toLowerCase()))];
  }
  return { ok: true, value: next };
}

// Observers of settings writes. The audit layer registers here to record
// admin changes; settings must not import the audit layer (it imports
// settings), so the dependency points one way and this hook carries events
// the other.
const changeListeners = [];
export function onSettingsChange(fn) {
  changeListeners.push(fn);
}

export function validateCompression(patch = {}) {
  const next = {};
  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
  if (patch.historyWindow !== undefined) {
    const n = Number(patch.historyWindow);
    if (!Number.isInteger(n) || n < 0 || n > 500) {
      return { ok: false, error: "historyWindow must be an integer between 0 (keep every message) and 500" };
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
        // Wrong or missing TOLLPIKE_SECRET. The value is unusable this boot,
        // but it is NOT absent: see isKeyUnreadable, which auth consults so
        // that "cannot read the key" refuses requests instead of reading as
        // "no key configured" and serving everyone. encodeForDisk also has to
        // put the original ciphertext back, or the first unrelated settings
        // write replaces it with this null and the key is gone for good.
        console.error(`[settings] cannot decrypt ${field}: ${err.message}`);
        out[field] = null;
      }
    }
  }
  return out;
}

/**
 * @param {string[]} explicit
 *   Fields the caller actually named in its patch. Everything else is being
 *   carried along by the read-modify-write in updateSettings, and a field
 *   nobody asked to change must come out of here exactly as it went in.
 */
function encodeForDisk(value, { explicit = [] } = {}) {
  const out = { ...value };
  const onDisk = readRaw();
  for (const field of ENCRYPTED_FIELDS) {
    const v = out[field];
    if (typeof v === "string" && v.length > 0 && isEncryptionAvailable()) {
      out[field] = encrypt(v);
      continue;
    }
    // A field that failed to decrypt this boot reads back as null, and
    // updateSettings would then write that null straight over the ciphertext.
    // One unrelated settings change, a provider toggle or a budget cap, was
    // enough to destroy an encrypted gateway key permanently: not even the
    // correct TOLLPIKE_SECRET could recover it afterwards, because the
    // ciphertext itself was gone. Put it back untouched unless the caller
    // explicitly asked to change this field.
    const stored = onDisk[field];
    const wasUnreadable = v == null && stored && typeof stored === "object" && stored.encrypted === true;
    if (wasUnreadable && !explicit.includes(field)) out[field] = stored;
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
    knowledge: { ...DEFAULTS.knowledge, ...(stored.knowledge || {}) },
    audit: { ...DEFAULTS.audit, ...(stored.audit || {}) }
  };
}

export function updateSettings(patch) {
  const before = changeListeners.length ? getSettings() : null;
  const next = { ...getSettings(), ...patch };
  writeAtomic(encodeForDisk(next, { explicit: Object.keys(patch || {}) }));
  if (before) {
    const changed = Object.keys(patch || {}).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(next[k]));
    if (changed.length) {
      for (const fn of changeListeners) {
        try {
          fn({ changed, before, after: next });
        } catch (err) {
          console.error(`[settings] change listener failed: ${err.message}`);
        }
      }
    }
  }
  return next;
}

/**
 * A gateway key exists on disk but cannot be read this boot.
 *
 * Distinct from "no key configured", which is the ordinary open state. This
 * one used to be indistinguishable from it: decryption failure produced null,
 * and auth reads null as "nobody set a key", so a gateway that was configured
 * to require a key served every request unauthenticated the moment
 * TOLLPIKE_SECRET went missing. A systemd unit or container that lost the
 * variable is all it takes.
 *
 * Only reached when the decoded key is falsy, so the decrypt attempt here does
 * not run on the normal request path.
 */
export function isKeyUnreadable() {
  const stored = readRaw().gatewayApiKey;
  if (!(stored && typeof stored === "object" && stored.encrypted === true)) return false;
  try {
    decrypt(stored);
    return false;
  } catch {
    return true;
  }
}

// True only when the stored key is actually encrypted on disk, so the panel
// can report the real state instead of "is a secret configured".
// The control plane is never open. On first start the gateway creates an
// operator key, so the panel and admin API need it even from this machine:
// any local process, including the agents being audited, could otherwise
// switch off the audit watching it. The key is never printed to the gateway's
// own output (which ends up in journals and container logs); `tollpike key`
// shows it and `tollpike panel` opens the panel unlocked.
//
// A key that exists but cannot be decrypted is left alone: overwriting it
// would destroy the ciphertext the operator can still recover by restoring
// TOLLPIKE_SECRET.
export function ensureOperatorKey() {
  if (getSettings().gatewayApiKey) return { created: false };
  if (isKeyUnreadable()) return { created: false, unreadable: true };
  const s = updateSettings({ gatewayApiKey: generateApiKey(), modelAuth: getSettings().modelAuth || "local" });
  return { created: Boolean(s.gatewayApiKey), encrypted: isKeyEncryptedAtRest() };
}

// Whether the model endpoints (/v1, /mcp, /a2a, hooks) need a key. A key the
// gateway created for itself does not change them ("local"), so tools on this
// machine keep working. A settings file from before this field existed, with a
// key the operator set deliberately, keeps the stricter behaviour it had.
export function modelKeyRequired(s = getSettings()) {
  if (s.modelAuth === "required") return true;
  if (s.modelAuth === "local") return false;
  return Boolean(s.gatewayApiKey);
}

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
