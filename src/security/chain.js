// Hash-chain primitives shared by the usage ledger and the audit log.
//
// Both files are append-only JSONL where each row carries `h`, a MAC over the
// previous row's `h` and this row's canonical payload. The primitives live
// here once, because two copies of "how a row is hashed" is two things that
// can drift apart, and a verifier that disagrees with its writer reports
// tampering on an untouched file.

import crypto from "node:crypto";

// Deterministic serialization of a row's payload, excluding the chain field
// `h`. Keys are sorted so re-serializing a parsed row reproduces the exact
// bytes hashed at write time regardless of key order on disk, and
// undefined-valued fields are dropped to match JSON.stringify, so an absent
// field hashes identically whether it was omitted or written.
export function canonicalPayload(row) {
  const keys = Object.keys(row).filter((k) => k !== "h" && row[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + JSON.stringify(row[k])).join(",") + "}";
}

// h = MAC(prevHead + "\n" + canonicalPayload). HMAC-SHA256 when a key is
// given; a bare SHA-256 otherwise. The unkeyed form still chains, so a naive
// edit is caught at the next row, but it is forgeable by anyone who can
// rewrite the whole tail, which is why every report says `keyed: false` and
// nothing claims tamper-evidence without a key.
export function chainHashWith(key, prevHead, canon) {
  const input = prevHead + "\n" + canon;
  return key
    ? crypto.createHmac("sha256", key).update(input).digest("hex")
    : crypto.createHash("sha256").update(input).digest("hex");
}

// Constant-time hex compare. This is MAC verification: the stored value is
// attacker-controlled and the key is secret, so it gets the same treatment
// as the gateway-key check. Length or encoding mismatch is a plain false.
export function hexEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || a.length === 0) {
    return false;
  }
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export function anchorTag(key, count, head) {
  return crypto.createHmac("sha256", key).update(`${count}:${head}`).digest("hex");
}
