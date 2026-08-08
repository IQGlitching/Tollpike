// Token-bucket rate limiter, per client identity. Protects against a
// runaway agent loop burning your paid quota in seconds — the failure mode
// that actually costs money on a personal gateway — as well as basic abuse
// if you expose the port beyond localhost.
//
// Identity is the gateway API key when auth is on, otherwise the source IP.
// In-memory only: a restart resets the buckets, which is fine for a
// single-process personal gateway and avoids a storage dependency.

import { fingerprint } from "../security/crypto.js";

const buckets = new Map(); // identity -> { tokens, lastRefill }

// Buckets are only ever added on a request, and a process that ran for a
// long time behind a changing set of clients would otherwise accumulate one
// entry per identity forever.
const MAX_BUCKETS = 10_000;

let config = {
  enabled: false,
  capacity: 60, // burst size
  refillPerMinute: 60 // sustained rate
};

// Validated at the boundary: a non-numeric or zero capacity would either
// disable the limiter silently or reject every request forever.
export function configure(patch = {}) {
  const next = { ...config };
  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
  for (const field of ["capacity", "refillPerMinute"]) {
    if (patch[field] === undefined) continue;
    const n = Number(patch[field]);
    if (!Number.isFinite(n) || n <= 0) {
      throw Object.assign(new Error(`rateLimit.${field} must be a positive number`), { status: 400 });
    }
    next[field] = n;
  }
  config = next;
  return config;
}

export function getConfig() {
  return { ...config };
}

function identify(req) {
  const header = req.headers.authorization ||
    (typeof req.headers["x-api-key"] === "string" ? `Bearer ${req.headers["x-api-key"]}` : "");
  if (header.startsWith("Bearer ")) {
    // Keyed by an HMAC of the token, not by a prefix of it. The prefix form
    // met the letter of "don't store key material" but let anyone *derive*
    // another client's bucket id: generated keys all begin `tpk_`, leaving
    // only a few characters to guess, so an unauthenticated caller could
    // deliberately collide with the operator's bucket and drain it. The
    // HMAC key is random per process, so identities can't be precomputed.
    return "key:" + fingerprint(header.slice(7));
  }
  return "ip:" + (req.ip || req.socket?.remoteAddress || "unknown");
}

function take(identity) {
  const now = Date.now();
  let bucket = buckets.get(identity);

  if (!bucket) {
    if (buckets.size >= MAX_BUCKETS) {
      // Map preserves insertion order; drop the oldest identity.
      buckets.delete(buckets.keys().next().value);
    }
    bucket = { tokens: config.capacity, lastRefill: now };
    buckets.set(identity, bucket);
  }

  // Refill proportionally to elapsed time, capped at capacity.
  const elapsedMs = now - bucket.lastRefill;
  const refill = (elapsedMs / 60000) * config.refillPerMinute;
  bucket.tokens = Math.min(config.capacity, bucket.tokens + refill);
  bucket.lastRefill = now;

  if (bucket.tokens < 1) {
    const msUntilNextToken = ((1 - bucket.tokens) / config.refillPerMinute) * 60000;
    return { allowed: false, retryAfterSec: Math.ceil(msUntilNextToken / 1000) };
  }

  bucket.tokens -= 1;
  return { allowed: true, remaining: Math.floor(bucket.tokens) };
}

export function rateLimit(req, res, next) {
  if (!config.enabled) return next();

  const result = take(identify(req));

  if (!result.allowed) {
    res.set("Retry-After", String(result.retryAfterSec));
    return res.status(429).json({
      error: "Rate limit exceeded",
      retryAfterSeconds: result.retryAfterSec
    });
  }

  res.set("X-RateLimit-Remaining", String(result.remaining));
  next();
}

export function stats() {
  return { enabled: config.enabled, trackedClients: buckets.size, ...config };
}

export function reset() {
  buckets.clear();
}
