// Cross-site request guard.
//
// hostGuard next door stops DNS rebinding, and it is easy to mistake that for
// covering this. It does not. Rebinding is the attack you need when you want to
// READ the response from an origin the browser will let you read; it is defeated
// by refusing unrecognised Host headers. But a state-changing request does not
// need its response read to do damage, and it does not need rebinding either:
// a plain <form action="http://127.0.0.1:20128/api/panel/services/bifrost/start">
// on any page the operator visits sends `Host: 127.0.0.1:20128`, which is an IP
// literal and therefore something hostGuard allows by design.
//
// The second thing that looks like a defence and isn't: express.json() only
// parses application/json, and a cross-site form cannot set that content type
// without triggering a preflight the server would fail. True — but every handler
// that defaults its fields runs anyway on an unparsed body. `req.body || {}`
// then selects the defaults, which is how an empty cross-site POST reached the
// paid routing path in /api/panel/providers/:id/test.
//
// So the check is on the request's PROVENANCE rather than its shape:
//
//   Sec-Fetch-Site  set by every current browser, and not settable by script.
//                   `same-origin` and `none` (a user typing the URL) are fine;
//                   `cross-site` and `same-site` are not.
//   Origin          the fallback for browsers predating Sec-Fetch metadata.
//                   Compared against the Host the request was addressed to.
//
// A request carrying NEITHER header is a non-browser client — curl, an SDK,
// Claude Code — and is allowed through. That is the deliberate limit of this
// control: it defends the browser-driven attack, which is the one the operator
// cannot otherwise avoid, and it does not pretend to authenticate anything.
// Auth is requireGatewayKey's job.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// `none` means a user-initiated navigation (typed URL, bookmark). A form POST
// from a page is never `none`, so this does not open the hole back up.
const SAFE_FETCH_SITES = new Set(["same-origin", "none"]);

export function isCrossSite(req) {
  const site = req.get?.("Sec-Fetch-Site") ?? req.headers?.["sec-fetch-site"];
  if (site) return !SAFE_FETCH_SITES.has(String(site).toLowerCase());

  const origin = req.get?.("Origin") ?? req.headers?.origin;
  if (!origin) return false; // no browser provenance at all — not a browser

  // A sandboxed iframe or a cross-origin redirect sends the literal "null".
  // It carries no host to compare, so it cannot be shown to be same-origin.
  if (origin === "null") return true;

  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true; // unparseable Origin is not something to give the benefit of
  }
  const host = req.get?.("Host") ?? req.headers?.host;
  return originHost !== host;
}

export function csrfGuard(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (!isCrossSite(req)) return next();

  res.status(403).json({
    error: "Cross-site request rejected",
    hint:
      "This endpoint changes state and was called from another origin. Browsers cannot be " +
      "allowed to drive the gateway on a page's behalf. Call it from a non-browser client, " +
      "or serve your tooling from the same origin as the gateway."
  });
}
