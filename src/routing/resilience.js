// Three independent failure scopes, nested smallest-to-largest:
//
//   model ⊂ connection ⊂ provider
//
// The point is to fail at the SMALLEST scope that explains the failure,
// so one bad thing doesn't take down everything above it:
//   - One model hits its quota  -> lock that model, other models on the
//                                  same key keep serving.
//   - One API key gets rejected -> cool that key down, other keys for the
//                                  same provider keep serving.
//   - The provider itself is down -> open the breaker, skip it entirely
//                                  until it recovers.
//
// A flat provider-only breaker (what this gateway had before) would treat
// all three identically and disable far more capacity than necessary.
//
// Recovery is lazy — checked on access, no background timers to leak.

const providers = new Map(); // providerId -> { status, failures, openedAt }
const connections = new Map(); // providerId::keyId -> { until, failures }
const models = new Map(); // providerId::model -> { until, reason }

const PROVIDER_FAILURE_THRESHOLD = 3;
const PROVIDER_COOLDOWN_MS = 30_000;
const CONNECTION_COOLDOWN_MS = 60_000;
// The two durations that actually run, named rather than inline at the call
// sites. The old default of 5 minutes was never used by either path, but it
// was still what snapshot().policy advertised as "the model lockout rule",
// so the panel and every MCP client reading that block were told a number
// that describes nothing. A 429 benches a model for a minute; a 404 means the
// model is not there and a retry will not conjure it, so it sits out longer.
const MODEL_LOCKOUT_MS = 60_000;
const MODEL_NOT_FOUND_LOCKOUT_MS = 30 * 60_000;

// --- Layer 1: provider circuit breaker ----------------------------------

function providerState(providerId) {
  if (!providers.has(providerId)) {
    providers.set(providerId, { status: "CLOSED", failures: 0, openedAt: 0, probeStartedAt: 0 });
  }
  return providers.get(providerId);
}

/**
 * Would this provider serve a request right now? Read-only.
 *
 * Anything that lists or reports on providers wants this one. The gate below
 * moves breaker state, and listing the fleet should not advance a breaker.
 */
export function canServe(providerId) {
  const s = providerState(providerId);
  if (s.status === "CLOSED" || s.status === "HALF_OPEN") return true;
  return Date.now() - s.openedAt > PROVIDER_COOLDOWN_MS;
}

/**
 * The routing gate: claims the right to send one request to this provider.
 *
 * HALF_OPEN used to return true unconditionally, so the "allow one probe"
 * this comment has always promised was only true when requests arrived one at
 * a time with the answer to each landing before the next was checked. Under
 * any concurrency the whole in-flight burst passed the gate together and every
 * one of them waited out the full timeout against a provider already known to
 * be down, which is the pile-up the breaker exists to prevent. Measured at 50
 * of 50 before this changed.
 *
 * Exactly one probe is admitted per cooldown window. The window doubles as the
 * safety valve: a probe that never reports back (a dropped request records
 * neither success nor failure) would otherwise bench the provider forever, so
 * once the window passes without a verdict the next caller may probe again.
 */
export function isProviderAvailable(providerId) {
  const s = providerState(providerId);
  if (s.status === "CLOSED") return true;

  if (s.status === "OPEN") {
    if (Date.now() - s.openedAt > PROVIDER_COOLDOWN_MS) {
      s.status = "HALF_OPEN";
      s.probeStartedAt = Date.now();
      return true;
    }
    return false;
  }

  // HALF_OPEN: a probe is already out. Wait for its verdict, or take over if
  // it never arrived.
  if (Date.now() - s.probeStartedAt > PROVIDER_COOLDOWN_MS) {
    s.probeStartedAt = Date.now();
    return true;
  }
  return false;
}

export function recordProviderFailure(providerId) {
  const s = providerState(providerId);
  s.failures += 1;
  if (s.status === "HALF_OPEN" || s.failures >= PROVIDER_FAILURE_THRESHOLD) {
    s.status = "OPEN";
    s.openedAt = Date.now();
  }
}

// --- Layer 2: per-connection (per API key) cooldown ---------------------

function connKey(providerId, keyId) {
  return `${providerId}::${keyId}`;
}

export function isConnectionAvailable(providerId, keyId) {
  const entry = connections.get(connKey(providerId, keyId));
  if (!entry) return true;
  if (Date.now() > entry.until) {
    connections.delete(connKey(providerId, keyId)); // lazy recovery
    return true;
  }
  return false;
}

export function coolDownConnection(providerId, keyId, ms = CONNECTION_COOLDOWN_MS) {
  const k = connKey(providerId, keyId);
  const existing = connections.get(k);
  connections.set(k, {
    until: Date.now() + ms,
    // Kept so a reader can tell how far through a cooldown it is. The
    // remaining seconds alone say "47s left" without saying left of what.
    totalMs: ms,
    failures: (existing?.failures || 0) + 1
  });
}

// --- Layer 3: per-model lockout -----------------------------------------

function modelKey(providerId, model) {
  return `${providerId}::${model}`;
}

export function isModelAvailable(providerId, model) {
  const entry = models.get(modelKey(providerId, model));
  if (!entry) return true;
  if (Date.now() > entry.until) {
    models.delete(modelKey(providerId, model)); // lazy recovery
    return true;
  }
  return false;
}

export function lockOutModel(providerId, model, reason = "quota", ms = MODEL_LOCKOUT_MS) {
  models.set(modelKey(providerId, model), { until: Date.now() + ms, totalMs: ms, reason });
}

// --- Success clears every layer for that path ---------------------------

export function recordSuccess(providerId, keyId, model) {
  const s = providerState(providerId);
  s.status = "CLOSED";
  s.failures = 0;
  if (keyId !== undefined) connections.delete(connKey(providerId, keyId));
  if (model !== undefined) models.delete(modelKey(providerId, model));
}

// --- Failure classification: decide which layer to trip -----------------

// This is the heart of the 3-layer design. The HTTP status (and where
// available, the error body) tells us the smallest scope that explains
// the failure, so we disable no more capacity than necessary.
export function classifyAndRecord(providerId, keyId, model, error) {
  const status = error?.status;

  // 401/403 -> this credential is bad. Other keys may still be fine, and
  // the provider itself is almost certainly up.
  if (status === 401 || status === 403) {
    coolDownConnection(providerId, keyId);
    return "connection";
  }

  // 429 -> a quota/rate limit. Usually model- or key-scoped, not a
  // provider outage. Lock the model rather than nuking the whole provider.
  if (status === 429) {
    lockOutModel(providerId, model, "rate_limit", MODEL_LOCKOUT_MS);
    return "model";
  }

  // 404 on a model path -> that model doesn't exist here. Long lockout,
  // since retrying won't make it appear.
  if (status === 404) {
    lockOutModel(providerId, model, "not_found", MODEL_NOT_FOUND_LOCKOUT_MS);
    return "model";
  }

  // Any other 4xx is the caller's request being wrong, not the provider being
  // unhealthy: 400 malformed, 413 too large, 422 unprocessable. The comment
  // below always said "5xx / network / timeout", but the fall-through caught
  // every status it had not already named, so a caller sending requests a
  // provider rejects could open the breaker on a lane that was answering
  // everyone else perfectly. Three bad requests removed a healthy provider for
  // thirty seconds, for every caller, and the sender saw only a generic
  // failure. 408 is excluded because a request timeout genuinely is the
  // provider being slow.
  //
  // Nothing is recorded here. The candidate still fails and the walk still
  // moves on, so a lane that cannot serve this particular request is not
  // retried pointlessly, but its health is left alone.
  if (status >= 400 && status < 500 && status !== 408) {
    return "request";
  }

  // 5xx / network / timeout / 408 -> the provider itself is unhealthy.
  recordProviderFailure(providerId);
  return "provider";
}

// --- Introspection ------------------------------------------------------

export function snapshot() {
  const now = Date.now();
  return {
    providers: Object.fromEntries(
      [...providers.entries()].map(([id, s]) => [id, {
        status: s.status,
        failures: s.failures,
        // How long an OPEN breaker has left before the next call is allowed
        // to probe it. Null while closed — there is nothing to wait for.
        probeInSecRemaining: s.status === "OPEN"
          ? Math.max(0, Math.ceil((s.openedAt + PROVIDER_COOLDOWN_MS - now) / 1000))
          : null
      }])
    ),
    connections: Object.fromEntries(
      [...connections.entries()]
        .filter(([, v]) => v.until > now)
        .map(([k, v]) => [k, {
          cooldownSecRemaining: Math.ceil((v.until - now) / 1000),
          cooldownSecTotal: Math.round((v.totalMs || CONNECTION_COOLDOWN_MS) / 1000),
          failures: v.failures
        }])
    ),
    models: Object.fromEntries(
      [...models.entries()]
        .filter(([, v]) => v.until > now)
        .map(([k, v]) => [k, {
          lockedSecRemaining: Math.ceil((v.until - now) / 1000),
          lockedSecTotal: Math.round((v.totalMs || MODEL_LOCKOUT_MS) / 1000),
          reason: v.reason
        }])
    ),
    // The rules the three layers run on, so a reader does not have to infer
    // "one more failure opens it" from a raw count.
    policy: {
      providerFailureThreshold: PROVIDER_FAILURE_THRESHOLD,
      providerCooldownSec: PROVIDER_COOLDOWN_MS / 1000,
      connectionCooldownSec: CONNECTION_COOLDOWN_MS / 1000,
      modelLockoutSec: MODEL_LOCKOUT_MS / 1000,
      modelNotFoundLockoutSec: MODEL_NOT_FOUND_LOCKOUT_MS / 1000
    }
  };
}

export function reset() {
  providers.clear();
  connections.clear();
  models.clear();
}

// Clear all three scopes for ONE provider.
//
// Needed when a credential is replaced: connection ids are positional
// (`groq#0`), so a fresh key lands on the id the rejected one just poisoned
// and would inherit its cooldown — the lane would sit out a minute for a
// failure that belongs to a credential no longer present. Scoped rather than
// a full `reset()` so fixing one lane doesn't clear another lane's breaker,
// which is real state about a provider that is genuinely down.
export function clearProvider(providerId) {
  const prefix = `${providerId}::`;
  providers.delete(providerId);
  for (const key of [...connections.keys()]) if (key.startsWith(prefix)) connections.delete(key);
  for (const key of [...models.keys()]) if (key.startsWith(prefix)) models.delete(key);
}
