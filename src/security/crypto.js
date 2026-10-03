import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../paths.js";

const saltPath = path.join(dataDir, ".salt");

// AES-256-GCM: authenticated encryption, so tampering with the ciphertext
// is detected on decrypt rather than silently producing garbage. GCM also
// means we don't need a separate MAC.
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV is the GCM standard
const KEY_LENGTH = 32;

// Persist a random salt so a derived key is stable across restarts but still
// unique per install (defeats precomputed/rainbow attacks). Shared by every
// key derived from TOLLPIKE_SECRET, so the salt is written exactly once.
function loadSalt() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (fs.existsSync(saltPath)) return fs.readFileSync(saltPath);
  const salt = crypto.randomBytes(16);
  fs.writeFileSync(saltPath, salt, { mode: 0o600 });
  return salt;
}

// The master passphrase comes from TOLLPIKE_SECRET. If it isn't set,
// encryption is DISABLED rather than silently falling back to a hardcoded
// key, a hardcoded key would give the appearance of encryption with none
// of the protection, which is worse than storing plaintext honestly.
function getMasterKey() {
  const secret = process.env.TOLLPIKE_SECRET;
  if (!secret) return null;

  // scrypt is deliberately slow/memory-hard, so a stolen data/ directory
  // can't be brute-forced cheaply.
  return crypto.scryptSync(secret, loadSalt(), KEY_LENGTH);
}

// A separate key for the usage-ledger hash chain. Derived from the same
// secret and salt as the AES key above, but domain-separated through an HMAC
// so the two can never coincide: reusing one key across two primitives is a
// vulnerability in its own right. Null when no secret is set, the ledger
// then falls back to an unkeyed SHA-256 chain, which detects accidental
// corruption and naive edits but not a motivated local editor, and reports
// `keyed: false` so nothing overclaims tamper-evidence it cannot provide.
export function ledgerKey() {
  return chainKey("tollpike-ledger-chain-v1");
}

// The audit log's chain key. Same secret, its own label, so a MAC valid in one
// chain is never valid in the other and a row cannot be moved between them.
export function auditKey() {
  return chainKey("tollpike-audit-chain-v1");
}

function chainKey(label) {
  const secret = process.env.TOLLPIKE_SECRET;
  if (!secret) return null;
  const master = crypto.scryptSync(secret, loadSalt(), KEY_LENGTH);
  return crypto.createHmac("sha256", master).update(label).digest();
}

export function isEncryptionAvailable() {
  return Boolean(process.env.TOLLPIKE_SECRET);
}

export function encrypt(plaintext) {
  const key = getMasterKey();
  if (!key) return { encrypted: false, value: plaintext };

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // iv:authTag:ciphertext, all hex, so it round-trips through JSON safely.
  return {
    encrypted: true,
    value: `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`
  };
}

export function decrypt(stored) {
  if (!stored || stored.encrypted !== true) return stored?.value ?? null;

  const key = getMasterKey();
  if (!key) {
    throw new Error(
      "Encrypted value found but TOLLPIKE_SECRET is not set, cannot decrypt. " +
        "Set the same secret you used when the value was written."
    );
  }

  const [ivHex, authTagHex, ciphertextHex] = String(stored.value).split(":");
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error("Malformed encrypted value");
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

  // If the ciphertext or tag was tampered with, final() throws here.
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final()
  ]).toString("utf8");
}

// Constant-time comparison for secrets. A plain `!==` leaks how many
// leading characters matched via response timing, which is enough to
// recover a key byte-by-byte over many requests.
export function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch, so hash both to a fixed
  // length first, this compares in constant time regardless of input size.
  const hashA = crypto.createHash("sha256").update(bufA).digest();
  const hashB = crypto.createHash("sha256").update(bufB).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

// Generates a cryptographically random gateway key, so users aren't
// tempted to pick "password123" in the control panel.
export function generateApiKey() {
  return "tpk_" + crypto.randomBytes(24).toString("base64url");
}

// Per-process HMAC key, regenerated on every boot. Never persisted: it only
// needs to be unpredictable to outside callers for the lifetime of the
// process.
const FINGERPRINT_KEY = crypto.randomBytes(32);

// Stable, non-reversible identifier for a secret, for use as a map key
// where the secret itself must not be stored and must not be guessable.
//
// A raw prefix of the token (the previous approach) satisfies "don't store
// the whole secret" while still letting an outsider *derive* the identifier:
// generated keys start with a fixed `tpk_`, so a handful of characters is
// enough to collide with someone else's entry on purpose.
export function fingerprint(value) {
  return crypto.createHmac("sha256", FINGERPRINT_KEY).update(String(value)).digest("hex").slice(0, 32);
}
