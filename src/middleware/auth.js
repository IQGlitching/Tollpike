import { getSettings, isKeyUnreadable, modelKeyRequired } from "../storage/settings.js";
import { safeCompare, fingerprint } from "../security/crypto.js";
import { hasAgentKeys, hasSensorKeys, matchAgentKey } from "../audit/agents.js";
import { recordAuthFailure } from "../audit/index.js";

// The control plane (the panel's API and every admin endpoint) always needs
// the operator key, which the gateway creates on first start. Model endpoints
// (/v1, /mcp, /a2a, hooks) take keyless calls from this machine unless the
// operator requires a key there too (settings.modelAuth) or agent keys exist.
// The static control panel HTML/JS is intentionally left unprotected by this
// middleware (it has no data of its own: it calls the protected API with a key
// stored in the operator's own browser).
//
// Agent keys (src/audit/agents.js) are a second kind of credential. Each one
// identifies a single agent, so every audited action carries its name, and
// each reaches the model endpoints only. Creating the first agent key makes a
// key mandatory on those endpoints even with no operator key set: from then
// on an agent that does not identify itself is refused, which is what turns
// attribution from voluntary into enforced. Agent keys never open the control
// plane, and issuing them never locks the operator out of it.

// The surfaces an agent key may call. Everything else under /api is the
// control plane, and an agent must not be able to reconfigure the gateway
// that is auditing it.
// "/mcp" also covers "/mcp-proxy"; "/audit/hooks/" is where agent runtimes
// report their own actions (layer two of the audit design).
const MODEL_SURFACES = ["/v1/", "/api/chat", "/api/tags", "/api/version", "/mcp", "/a2a", "/audit/hooks/"];

export function isModelSurface(req) {
  const p = String(req.originalUrl || req.url || "").split("?")[0];
  return MODEL_SURFACES.some((s) => p === s.replace(/\/$/, "") || p.startsWith(s));
}

// Where endpoint sensors submit telemetry. Sensor keys reach this and nothing
// else; agent keys never reach it.
export function isSensorSurface(req) {
  return String(req.originalUrl || req.url || "").split("?")[0].startsWith("/audit/endpoint/");
}

function presentedToken(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7);
  return typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : "";
}

export function requireGatewayKey(req, res, next) {
  const { gatewayApiKey } = getSettings();
  const agentKeysRequired = (hasAgentKeys() && isModelSurface(req)) || (hasSensorKeys() && isSensorSurface(req));

  // An agent key is honoured wherever it is presented, so a request that
  // carries one is attributed even before keys are mandatory.
  const presented = presentedToken(req);
  const agentMatch = presented ? matchAgentKey(presented) : null;
  if (agentMatch?.agent?.kind === "sensor") {
    if (!isSensorSurface(req)) {
      recordAuthFailure(req, "sensor key used outside endpoint ingest");
      return res.status(403).json({ error: "Sensor keys can submit endpoint telemetry (/audit/endpoint/events) only." });
    }
    req.sensor = agentMatch.agent;
    req.callerId = `sensor:${agentMatch.agent.id}`;
    return next();
  }
  if (agentMatch?.agent && isSensorSurface(req)) {
    recordAuthFailure(req, "agent key used for endpoint ingest");
    return res.status(403).json({ error: "An agent key cannot submit endpoint telemetry. Issue a sensor key: tollpike agents add <name> --sensor" });
  }
  if (agentMatch?.agent) {
    if (!isModelSurface(req)) {
      recordAuthFailure(req, "agent key used on the control plane");
      return res.status(403).json({
        error: "Agent keys can call the model endpoints (/v1, /api/chat, /mcp, /a2a) only. The control plane needs the operator key."
      });
    }
    req.agent = agentMatch.agent;
    req.callerId = `agent:${agentMatch.agent.id}`;
    return next();
  }
  if (agentMatch?.revoked) {
    recordAuthFailure(req, "revoked agent key");
    return res.status(401).json({ error: "This agent key has been revoked." });
  }

  if (!gatewayApiKey && !agentKeysRequired) {
    // "Cannot read the key" is not "no key was set". An undecryptable key
    // decodes to null, which used to land here and open the gateway to
    // everyone, silently, at exactly the moment its protection was needed.
    // Refuse instead, and say what to do: the ciphertext is still on disk, so
    // restoring TOLLPIKE_SECRET restores access, and the README documents
    // clearing gatewayApiKey by hand for an operator who lost the secret.
    if (isKeyUnreadable()) {
      return res.status(503).json({
        error:
          "Gateway key cannot be decrypted. Set TOLLPIKE_SECRET to the value used when it was " +
          "written, or clear gatewayApiKey in data/settings.json to disable auth deliberately."
      });
    }
    req.callerId = "anonymous";
    return next();
  }

  // Keyless use of a model endpoint, when the operator allows it: from this
  // machine only, so a gateway bound to a wider address never serves model
  // calls to the network without a key. A token that is not the operator key
  // is ignored rather than refused here, because local clients routinely send a
  // placeholder (Claude Code always sends x-api-key).
  const modelLike = isModelSurface(req) || isSensorSurface(req);
  if (modelLike && !agentKeysRequired && !modelKeyRequired()) {
    if (presented && safeCompare(presented, gatewayApiKey)) {
      req.callerId = fingerprint(presented);
      return next();
    }
    if (isLoopbackRequest(req)) {
      req.callerId = "anonymous";
      return next();
    }
    recordAuthFailure(req, presented ? "invalid key" : "missing key");
    return res.status(401).json({ error: "Keyless model calls are accepted from this machine only. Send the operator key or an agent key." });
  }

  // Anthropic clients (Claude Code, the Anthropic SDK) authenticate with
  // `x-api-key` rather than a bearer token, so the inbound /v1/messages
  // endpoint would be unreachable if only Authorization were accepted.
  const token = presented;

  // Constant-time comparison. A plain `!==` returns as soon as it hits a
  // differing character, so response timing leaks how many leading
  // characters were correct — enough to recover the key byte-by-byte.
  if (!gatewayApiKey || !safeCompare(token, gatewayApiKey)) {
    recordAuthFailure(req, token ? "invalid key" : "missing key");
    return res.status(401).json({
      error: agentKeysRequired && !gatewayApiKey ? "An agent key is required on this endpoint." : "Invalid or missing gateway API key"
    });
  }

  // Non-reversible identity for the authenticated caller. Downstream layers
  // (rate limiting, cache partitioning) key off this rather than the token,
  // so the secret never becomes a map key and the cache can be scoped per
  // caller the moment more than one key exists.
  req.callerId = fingerprint(token);
  next();
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopbackRequest(req) {
  // `trust proxy` is off, so req.ip is the socket peer and cannot be spoofed
  // with X-Forwarded-For. That is the whole reason this check is worth making.
  const ip = req.ip || req.socket?.remoteAddress || "";
  return LOOPBACK.has(ip);
}

// For the two endpoints that write secrets: setting a provider credential and
// setting the gateway key itself.
//
// The operator key is created on first start, so normally it is set. If it is
// not (a data directory from before 0.10, or one edited by hand),
// requireGatewayKey waves requests through, and "no key set" must not also mean
// "anyone who can reach the port may write my credentials". So when auth is
// off, these endpoints accept the request only from the machine itself.
//
// By the time a request reaches here, requireGatewayKey has already run on
// /api and rejected any invalid token, so a configured key means the caller
// is authenticated and location no longer matters.
export function requireAuthenticatedOrLocal(req, res, next) {
  const { gatewayApiKey } = getSettings();
  if (gatewayApiKey) return next();
  if (isLoopbackRequest(req)) return next();
  return res.status(403).json({
    error:
      "This endpoint writes a credential. With no gateway key set it is reachable " +
      "only from the machine running the gateway. Set a gateway key on the Access " +
      "page, then retry with Authorization: Bearer <key>."
  });
}
