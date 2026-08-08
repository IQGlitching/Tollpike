import net from "node:net";

// DNS-rebinding guard.
//
// The control plane is reachable without a gateway key by default, and the
// browser same-origin policy is not a defence here: an attacker's page can
// point a hostname they control at 127.0.0.1, wait for the DNS TTL to
// expire, and then read and write this API from that origin as if it were
// their own. The Host header is the part they cannot forge away — a
// rebinding attack necessarily arrives carrying their domain name.
//
// So: accept requests addressed to an IP literal or to localhost, and
// reject requests addressed to some other name unless it was explicitly
// allowed via TOLLPIKE_ALLOWED_HOSTS.

const LOCAL_NAMES = new Set(["localhost", "localhost.localdomain", ""]);

function allowedFromEnv() {
  return new Set(
    (process.env.TOLLPIKE_ALLOWED_HOSTS || "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function hostnameOf(hostHeader) {
  if (!hostHeader) return "";
  const value = String(hostHeader).trim();
  // Bracketed IPv6 literal, e.g. [::1]:20128
  if (value.startsWith("[")) return value.slice(1, value.indexOf("]")).toLowerCase();
  return value.split(":")[0].toLowerCase();
}

export function isAllowedHost(hostHeader, allowed = allowedFromEnv()) {
  const host = hostnameOf(hostHeader);
  if (LOCAL_NAMES.has(host)) return true;
  if (net.isIP(host) !== 0) return true; // an IP literal can't be rebound
  return allowed.has(host);
}

export function hostGuard(req, res, next) {
  if (isAllowedHost(req.headers.host)) return next();
  res.status(403).json({
    error: "Request rejected: unrecognised Host header",
    hint:
      "This gateway only answers to localhost or an IP address. " +
      "If you front it with a hostname, list it in TOLLPIKE_ALLOWED_HOSTS."
  });
}
