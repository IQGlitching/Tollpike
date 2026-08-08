import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// The two endpoints that write a secret — a provider credential and the
// gateway key itself — are guarded by requireAuthenticatedOrLocal.
//
// requireGatewayKey deliberately waves everything through when no key is set,
// because demanding a key before you can set one is a bootstrap deadlock. The
// hole that leaves is specific: bind beyond loopback with no key configured,
// and anyone who can reach the port can write credentials into the operator's
// protected env file. This pins the rule that closes it — when auth is off,
// those endpoints answer only the local machine.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tollpike-authscope-"));
process.env.TOLLPIKE_DATA_DIR = tmp;

const { requireAuthenticatedOrLocal, isLoopbackRequest } = await import("../src/middleware/auth.js");

const settingsPath = path.join(tmp, "settings.json");
const setGatewayKey = (value) =>
  fs.writeFileSync(settingsPath, JSON.stringify({ gatewayApiKey: value }, null, 2));

// Minimal express-shaped doubles. `trust proxy` is off in the real app, so
// req.ip is the socket peer — a forged X-Forwarded-For cannot reach it.
const reqFrom = (ip) => ({ ip, socket: { remoteAddress: ip }, headers: {} });
function runGuard(req) {
  const out = { nexted: false, status: null, body: null };
  const res = {
    status(code) { out.status = code; return this; },
    json(payload) { out.body = payload; return this; }
  };
  requireAuthenticatedOrLocal(req, res, () => { out.nexted = true; });
  return out;
}

before(() => setGatewayKey(null));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

describe("loopback classification", () => {
  test("recognises every loopback form Node reports", () => {
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      assert.equal(isLoopbackRequest(reqFrom(ip)), true, `${ip} is loopback`);
    }
  });

  test("treats LAN and public addresses as remote", () => {
    for (const ip of ["192.168.1.50", "10.0.0.7", "172.16.4.4", "203.0.113.9", "::ffff:192.168.1.50"]) {
      assert.equal(isLoopbackRequest(reqFrom(ip)), false, `${ip} is not loopback`);
    }
  });

  test("an absent peer address is not treated as local", () => {
    assert.equal(isLoopbackRequest({ headers: {} }), false);
  });
});

describe("credential endpoints with auth OFF", () => {
  before(() => setGatewayKey(null));

  test("the local machine may bootstrap a key", () => {
    const out = runGuard(reqFrom("127.0.0.1"));
    assert.equal(out.nexted, true);
    assert.equal(out.status, null);
  });

  test("a remote caller is refused, and told why", () => {
    const out = runGuard(reqFrom("192.168.1.50"));
    assert.equal(out.nexted, false);
    assert.equal(out.status, 403);
    assert.match(out.body.error, /writes a credential/i);
    assert.match(out.body.error, /gateway key/i);
  });

  test("a forged X-Forwarded-For does not make a remote caller local", () => {
    const req = reqFrom("203.0.113.9");
    req.headers["x-forwarded-for"] = "127.0.0.1";
    assert.equal(runGuard(req).status, 403);
  });
});

describe("credential endpoints with auth ON", () => {
  before(() => setGatewayKey("a-configured-gateway-key-1234567890"));

  // requireGatewayKey runs first on /api and rejects an invalid token, so by
  // the time this guard sees the request the caller is already authenticated —
  // and an authenticated operator is allowed to work from anywhere.
  test("an authenticated remote caller is allowed through", () => {
    const out = runGuard(reqFrom("192.168.1.50"));
    assert.equal(out.nexted, true);
    assert.equal(out.status, null);
  });

  test("the local machine is still allowed through", () => {
    assert.equal(runGuard(reqFrom("127.0.0.1")).nexted, true);
  });
});
