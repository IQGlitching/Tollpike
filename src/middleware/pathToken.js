// Key-in-the-path aliases, for clients that cannot send a custom auth header.
//
// Some IDE integrations let you set a base URL but give you nowhere to put an
// Authorization header. The workaround is to carry the key in the path:
//
//   POST /vscode/tpk_abc123/chat/completions   ->  /v1/chat/completions
//   POST /key/tpk_abc123/v1/messages           ->  /v1/messages
//
// The prefix is stripped and the token is moved into the Authorization
// header before anything else looks at the request, so auth, rate limiting
// and routing all behave exactly as they would normally.
//
// SECURITY TRADE-OFF, deliberate and worth knowing: URLs leak in ways
// headers don't — proxy logs, browser history, Referer headers, crash
// reports. This is strictly worse than a header and exists only because some
// clients offer no alternative. It is therefore OFF unless you enable it,
// and the token never reaches the request logger (only the rewritten path
// is ever recorded).

const PREFIXES = ["vscode", "key", "t"];

export function isPathTokenEnabled() {
  return process.env.ALLOW_PATH_TOKEN === "true";
}

export function rewritePathToken(url) {
  const match = /^\/(vscode|key|t)\/([^/]+)(\/.*)$/.exec(url || "");
  if (!match) return null;

  const [, prefix, token, rest] = match;
  if (!PREFIXES.includes(prefix)) return null;

  // A malformed percent-escape — `/key/%/v1/models` — makes decodeURIComponent
  // throw URIError. Unguarded that propagated out of the middleware and became
  // a 500 on an unauthenticated path, which is a stranger's one-request way to
  // put noise in the operator's logs. A token that cannot be decoded is not a
  // token: treat the URL as one that carries no key and let it fall through to
  // ordinary routing, where it fails as the 401 or 404 it actually is.
  let decoded;
  try {
    decoded = decodeURIComponent(token);
  } catch {
    return null;
  }

  // `/vscode/KEY/chat/completions` omits the version segment that
  // `/vscode/KEY/v1/chat/completions` includes. Normalise both.
  const path = rest.startsWith("/v1/") || rest === "/v1" ? rest : `/v1${rest}`;
  return { token: decoded, path };
}

export function pathToken(req, res, next) {
  if (!isPathTokenEnabled()) return next();

  const rewritten = rewritePathToken(req.url);
  if (!rewritten) return next();

  // A header the client did manage to send wins — it's the safer channel.
  if (!req.headers.authorization) {
    req.headers.authorization = `Bearer ${rewritten.token}`;
  }
  req.url = rewritten.path;
  req.pathTokenUsed = true;
  next();
}
