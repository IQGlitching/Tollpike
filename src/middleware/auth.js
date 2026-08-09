import { getSettings, isKeyUnreadable } from "../storage/settings.js";
import { safeCompare, fingerprint } from "../security/crypto.js";

// No-op until you set a key from the control panel or settings.json.
// Once set, every /v1/* and /api/* request needs "Authorization: Bearer <key>".
// The static control panel HTML/JS is intentionally left unprotected by this
// middleware (it has no data of its own — it just calls the protected API
// with a key the user enters and stores in their own browser).
export function requireGatewayKey(req, res, next) {
  const { gatewayApiKey } = getSettings();

  if (!gatewayApiKey) {
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

  // Anthropic clients (Claude Code, the Anthropic SDK) authenticate with
  // `x-api-key` rather than a bearer token, so the inbound /v1/messages
  // endpoint would be unreachable if only Authorization were accepted.
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ")
    ? header.slice(7)
    : typeof req.headers["x-api-key"] === "string"
      ? req.headers["x-api-key"]
      : "";

  // Constant-time comparison. A plain `!==` returns as soon as it hits a
  // differing character, so response timing leaks how many leading
  // characters were correct — enough to recover the key byte-by-byte.
  if (!safeCompare(token, gatewayApiKey)) {
    return res.status(401).json({ error: "Invalid or missing gateway API key" });
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
// requireGatewayKey deliberately waves everything through when no key is set —
// an unauthenticated gateway on loopback is a supported way to run this thing,
// and demanding a key before you can set one would be a bootstrap deadlock. But
// "no key set" must not also mean "anyone who can reach the port may write my
// credentials". So when auth is off, these endpoints accept the request only
// from the machine itself.
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
