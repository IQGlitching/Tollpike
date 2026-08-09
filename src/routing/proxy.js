import { getSettings } from "../storage/settings.js";
import { getProvider } from "../providers/registry.js";
import { connectOptionsFor, tlsStatus } from "./tls.js";

// Honest proxy support: route upstream requests through an HTTP(S) or
// SOCKS5 proxy you control, so Tollpike works from networks that can't
// reach a provider directly.
//
// This does NOT intercept, decrypt or re-sign TLS. Not now and not as a future
// option — a gateway that terminates provider TLS holds every key and every
// prompt in cleartext at a hop the operator did not audit.
//
// It CAN shape the handshake this process itself sends (cipher and ALPN order),
// which is a different thing entirely and lives in routing/tls.js. Read the
// caveat there before relying on it: it changes the fingerprint, it does not
// impersonate a browser.
//
// Proxy resolution, three configured levels then the environment:
//   1. per-provider    settings.proxies[providerId]
//   2. per-category    settings.proxyCategories[provider.category]
//   3. global          settings.proxies["*"]
//   4. env vars        HTTPS_PROXY / HTTP_PROXY / ALL_PROXY
//   5. none
//
// The category level exists because the useful grouping in practice is not
// "one provider" or "all providers" but "everything in this class" — route the
// frontier labs through an audited egress and leave local runtimes direct,
// without restating the same URL for every entry and having to remember to add
// it again when a provider is added.
//
// Node 18+ dispatches fetch through undici. A proxy needs an undici
// ProxyAgent, which isn't a hard dependency here — if it isn't installed,
// we say so clearly rather than silently making a direct connection that
// the user believes is proxied.

let ProxyAgentCtor = null;
let AgentCtor = null;
let proxyLoadError = null;

try {
  // undici ships with Node 18+, so this normally resolves without adding
  // a dependency. Wrapped because minimal runtimes may exclude it.
  const undici = await import("undici");
  ProxyAgentCtor = undici.ProxyAgent;
  AgentCtor = undici.Agent;
} catch (err) {
  proxyLoadError = err.message;
}

// Keyed by proxy URL AND TLS profile: the two combine into one dispatcher, and
// caching on the URL alone meant changing the TLS profile kept using an agent
// built with the previous handshake settings.
const agentCache = new Map();

// Only these schemes make sense for an egress proxy. The panel endpoint
// accepted any string, which meant a malformed value was stored happily and
// then threw on every subsequent request — and a `file:`/`data:` value had
// no business reaching ProxyAgent at all.
const ALLOWED_PROXY_PROTOCOLS = new Set(["http:", "https:", "socks:", "socks4:", "socks5:", "socks5h:"]);

/**
 * A proxy URL with its password masked, for anything a caller can read.
 *
 * `http://user:pass@proxy:8080` is the ordinary way to configure an
 * authenticated egress proxy, and it is exactly how HTTPS_PROXY is usually
 * set, so these strings routinely carry a live credential. Every other secret
 * in this gateway is reported as a boolean or an id and never echoed: the
 * gateway key comes back as `locked`, provider credentials as `hasKey`, and
 * resilience tracks connection ids specifically so key material cannot appear
 * in a snapshot. Proxy URLs were the exception, returned verbatim by
 * proxyStatus, proxyPlan and the MCP proxy tools, and rendered into the panel.
 *
 * The host, port, scheme and username all survive, because those are what
 * makes the reading useful when egress goes somewhere unexpected. Only the
 * password goes. An unparseable value is replaced outright rather than echoed,
 * since we cannot tell what is inside it.
 */
export function redactProxyUrl(url) {
  if (typeof url !== "string" || url === "") return url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "***";
  }
  if (!parsed.username && !parsed.password) return url;
  const user = parsed.username;
  parsed.username = "";
  parsed.password = "";
  return parsed.toString().replace(/^([a-z0-9+.-]+:\/\/)/i, `$1${user ? `${user}:` : ""}***@`);
}

const redactMap = (map = {}) =>
  Object.fromEntries(Object.entries(map).map(([k, v]) => [k, redactProxyUrl(v)]));

export function validateProxyUrl(url) {
  if (url === null || url === undefined || url === "") return { ok: true, value: null };
  if (typeof url !== "string") return { ok: false, error: "proxy url must be a string" };

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: `"${url}" is not a valid URL` };
  }
  if (!ALLOWED_PROXY_PROTOCOLS.has(parsed.protocol)) {
    return {
      ok: false,
      error: `proxy protocol "${parsed.protocol}" is not supported (use ${[...ALLOWED_PROXY_PROTOCOLS].join(", ")})`
    };
  }
  if (!parsed.hostname) return { ok: false, error: "proxy url must include a host" };
  return { ok: true, value: url };
}

// Resolves through all three configured levels and then the environment,
// reporting WHICH level won. The level is not decoration: "why is this provider
// going direct when I set a global proxy" is unanswerable without it, and the
// usual answer is a per-provider entry someone forgot about.
export function resolveProxy(providerId) {
  const { proxies = {}, proxyCategories = {} } = getSettings();
  const category = getProvider(providerId)?.category;

  if (proxies[providerId]) return { url: proxies[providerId], level: "provider" };
  if (category && proxyCategories[category]) {
    return { url: proxyCategories[category], level: "category" };
  }
  if (proxies["*"]) return { url: proxies["*"], level: "global" };

  const envUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY;
  if (envUrl) return { url: envUrl, level: "env" };

  return { url: null, level: "none" };
}

export function resolveProxyUrl(providerId) {
  return resolveProxy(providerId).url;
}

// Returns a fetch options fragment to spread into the request, or {} for a
// stock direct connection. Throws only if a proxy is explicitly configured but
// cannot be honoured — failing loudly beats silently leaking traffic around a
// proxy the user set for a reason.
export function proxyDispatcher(providerId) {
  const { url: proxyUrl } = resolveProxy(providerId);
  const tlsProfile = getSettings().tlsProfile || "default";
  const connect = connectOptionsFor(tlsProfile);

  // No proxy and no TLS shaping: return nothing at all, so the request stays
  // on undici's global dispatcher and keeps its connection pooling. Building a
  // per-call Agent here would quietly discard keep-alive on the hot path.
  if (!proxyUrl && !connect) return {};

  if (!proxyUrl) {
    if (!AgentCtor) {
      throw new Error(
        `TLS profile "${tlsProfile}" is configured but undici's Agent is unavailable` +
          (proxyLoadError ? `: ${proxyLoadError}` : "") +
          ". Refusing to send this request with stock TLS settings, since that is not what was configured."
      );
    }
    const cacheKey = `direct|${tlsProfile}`;
    if (!agentCache.has(cacheKey)) agentCache.set(cacheKey, new AgentCtor({ connect }));
    return { dispatcher: agentCache.get(cacheKey) };
  }

  if (!ProxyAgentCtor) {
    throw new Error(
      `Proxy configured (${redactProxyUrl(proxyUrl)}) but undici's ProxyAgent is unavailable` +
        (proxyLoadError ? `: ${proxyLoadError}` : "") +
        ". Refusing to send this request directly, since that would bypass the proxy you configured."
    );
  }

  // Same principle as the ProxyAgent check above: if the configured proxy
  // can't be honoured, refuse the request rather than quietly sending it
  // direct and leaking traffic the operator believed was routed.
  const valid = validateProxyUrl(proxyUrl);
  if (!valid.ok) {
    throw new Error(
      `Configured proxy for "${providerId}" is unusable: ${valid.error}. ` +
        "Refusing to send this request directly, since that would bypass the proxy you configured."
    );
  }

  const cacheKey = `${proxyUrl}|${tlsProfile}`;
  if (!agentCache.has(cacheKey)) {
    // The TLS profile applies to the tunnelled connection as well: a CONNECT
    // proxy forwards our handshake to the origin untouched, so shaping it here
    // is the same shaping as a direct call.
    agentCache.set(cacheKey, new ProxyAgentCtor(connect ? { uri: proxyUrl, connect } : proxyUrl));
  }
  return { dispatcher: agentCache.get(cacheKey) };
}

export function proxyStatus() {
  const { proxies = {}, proxyCategories = {}, tlsProfile = "default" } = getSettings();
  return {
    available: Boolean(ProxyAgentCtor),
    loadError: proxyLoadError,
    // Masked, not raw. See redactProxyUrl: these strings carry a live
    // credential whenever the egress proxy needs authentication.
    configured: redactMap(proxies),
    categories: redactMap(proxyCategories),
    envFallback: redactProxyUrl(
      process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || null
    ),
    levels: ["provider", "category", "global", "env"],
    tls: tlsStatus(tlsProfile),
    // Explicit and permanent. It is the one thing about a gateway's egress
    // behaviour that someone will assume is happening if nobody says otherwise.
    interception: "none — provider TLS is never terminated, decrypted or re-signed"
  };
}

// What every configured provider will actually do, and at which level it was
// decided. This is the view that answers a routing surprise.
export function proxyPlan(providers) {
  return providers.map((p) => {
    const { url, level } = resolveProxy(p.id);
    return { provider: p.id, category: p.category, level, proxy: redactProxyUrl(url) };
  });
}

export function clearAgentCache() {
  agentCache.clear();
}
