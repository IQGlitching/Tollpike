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
const MODEL_LOCKOUT_MS = 5 * 60_000;

// --- Layer 1: provider circuit breaker ----------------------------------

function providerState(providerId) {
  if (!providers.has(providerId)) {
    providers.set(providerId, { status: "CLOSED", failures: 0, openedAt: 0 });
  }
  return providers.get(providerId);
}

export function isProviderAvailable(providerId) {
  const s = providerState(providerId);
  if (s.status === "CLOSED") return true;
  if (s.status === "OPEN") {
    if (Date.now() - s.openedAt > PROVIDER_COOLDOWN_MS) {
      s.status = "HALF_OPEN";
      return true; // allow one probe
    }
    return false;
  }
  return true; // HALF_OPEN
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
    lockOutModel(providerId, model, "rate_limit", 60_000);
    return "model";
  }

  // 404 on a model path -> that model doesn't exist here. Long lockout,
  // since retrying won't make it appear.
  if (status === 404) {
    lockOutModel(providerId, model, "not_found", 30 * 60_000);
    return "model";
  }

  // 5xx / network / timeout -> the provider itself is unhealthy.
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
      modelLockoutSec: MODEL_LOCKOUT_MS / 1000
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
