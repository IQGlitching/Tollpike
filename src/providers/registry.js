import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, "..", "..", "config", "providers.json");

const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));

// A provider can hold several API keys ("connections"). Set them
// comma-separated in the env var:
//     GROQ_API_KEY=key_one,key_two,key_three
// Each becomes an independently cooled-down connection, so one rejected
// or rate-limited key doesn't take the whole provider out of rotation.
function parseKeys(envValue) {
  if (!envValue) return [];
  return envValue
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

export const providers = raw.providers.map((p) => {
  const keys = parseKeys(process.env[p.apiKeyEnv]);
  // Local runtimes (Ollama, LM Studio, vLLM...) need no credential. Give
  // them a single placeholder connection so the connection layer, which
  // assumes at least one connection exists, works uniformly for them.
  if (p.requiresKey === false && keys.length === 0) keys.push("local");
  return {
    ...p,
    // Connections carry a stable id so the resilience layer can track each
    // key without ever storing the key material itself in its maps.
    connections: keys.map((key, i) => ({ id: `${p.id}#${i}`, key })),
    get apiKey() {
      return this.connections[0]?.key || null; // back-compat for single-key callers
    },
    get available() {
      return this.connections.length > 0;
    }
  };
});

export function getProvider(id) {
  return providers.find((p) => p.id === id);
}

// Rebuild one provider's connections from a credential supplied at runtime.
//
// Connections are otherwise built once, at import, from `process.env` — which
// means a key added after boot would sit in the env file doing nothing until
// someone restarted the gateway. That is a poor trade for a panel whose whole
// job is making the plaza operable, so the panel's key endpoint calls this and
// the lane opens immediately.
//
// `available` is a getter over `connections`, so nothing else needs to know
// this happened. Connection ids keep the `${id}#${n}` shape the resilience
// layer keys its cooldown maps by — and because a replaced key reuses those
// ids, the caller is expected to clear that provider's failure state so a new
// credential does not inherit the old one's cooldown.
export function applyCredential(providerId, rawValue) {
  const provider = getProvider(providerId);
  if (!provider) return null;
  const keys = parseKeys(rawValue);
  if (provider.requiresKey === false && keys.length === 0) keys.push("local");
  provider.connections = keys.map((key, i) => ({ id: `${providerId}#${i}`, key }));
  return provider.connections.length;
}

// Price for a specific model, falling back to the provider-level rate.
//
// A single rate per provider is wrong wherever a provider serves models at
// different prices, which is most of them: gpt-4o and gpt-4o-mini differ by
// ~17x, claude-opus and claude-haiku by ~5x. Billing every model at the
// provider's headline rate makes the monthly cap fire at the wrong time in
// whichever direction the mismatch runs — and under-counting is the
// dangerous direction, because the cap silently fails to fire at all.
export function priceFor(provider, model) {
  return provider.modelPricing?.[model] || provider.costPer1mTokens || { input: 0, output: 0 };
}

// True when the provider's pricing has actually been checked against vendor
// documentation. Everything else is inherited from the original unaudited
// config drop and should not be trusted to enforce a budget.
//
// The field carries one of three things: an ISO date (checked on that day),
// "n/a" (a local runtime with no rates to check), or false (never checked).
// The previous test was `=== "n/a" || typeof === "string"`, whose second clause
// subsumed the first and, more to the point, read ANY string as verified — so a
// future `pricingVerified: "unverified"` or `"false"` would have flipped a lane
// to trusted and silently suppressed the warning on the budget-cap endpoint
// that exists to say the cap may not fire. Match the shapes that mean verified
// rather than the type that happens to hold them.
const VERIFIED_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isPricingVerified(provider) {
  const value = provider?.pricingVerified;
  return value === "n/a" || (typeof value === "string" && VERIFIED_DATE.test(value));
}

export function availableProviders() {
  return providers.filter((p) => p.available);
}

// Context length for a model, or null when it isn't declared.
//
// null is deliberately not "assume 128k". The context-aware strategy sorts
// unknown-window providers behind known-fitting ones precisely because
// guessing a window produces the failure it exists to prevent: a 300k-token
// request routed to a 32k model, which 400s after the request has already
// been paid for on the prompt side at some vendors.
export function contextWindowFor(provider, model) {
  return provider?.modelContext?.[model] ?? provider?.contextWindow ?? null;
}

// How this lane is paid for. Drives the drain strategies.
//   local        no marginal cost, no quota
//   free-tier    a declared free allowance — see storage/quotaTracker.js
//   subscription a flat fee the operator already pays, so marginal cost is 0
//                until the plan's own limits bite. Operator-declared in
//                settings, never inferred: nothing in a provider's API says
//                "this key is covered by a plan you bought".
//   metered      pay per token
export function billingOf(provider, subscriptionProviders = []) {
  if (subscriptionProviders.includes(provider.id)) return "subscription";
  return provider.billing || (provider.category === "local" ? "local" : "metered");
}

// Resolve a requested model string into a concrete (provider, model) pair.
// Accepts:
//   "provider/model"  -> explicit
//   "auto"             -> handled upstream by the router, not here
//   bare "model"        -> first available provider that lists it
// Whether a provider will accept a model name it doesn't list. Off by
// default: `provider/anything` used to be forwarded verbatim, so the
// configured `models` array was documentation rather than an allowlist. A
// caller could reach any model the key can reach — including ones far more
// expensive than the entry's costPer1mTokens, which then billed at the
// wrong rate and made the monthly cap meaningless. Set
// ALLOW_UNLISTED_MODELS=true to opt back into passthrough.
const allowUnlisted = () => process.env.ALLOW_UNLISTED_MODELS === "true";

export function isModelAllowed(provider, model) {
  return allowUnlisted() || provider.models.includes(model);
}

export function resolveExplicit(modelString) {
  if (modelString.includes("/")) {
    const [providerId, ...rest] = modelString.split("/");
    const model = rest.join("/");
    const provider = getProvider(providerId);
    if (provider && isModelAllowed(provider, model)) return { provider, model };
    if (provider) return { provider, model, notAllowed: true };
  }
  for (const provider of providers) {
    if (provider.models.includes(modelString)) {
      return { provider, model: modelString };
    }
  }
  return null;
}
