import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

process.env.TOLLPIKE_SECRET = "test-secret-for-suite";
const crypto = await import("../src/security/crypto.js");

describe("crypto: encryption at rest", () => {
  test("round-trips a value", () => {
    const enc = crypto.encrypt("sk-secret-value");
    assert.equal(enc.encrypted, true);
    assert.equal(crypto.decrypt(enc), "sk-secret-value");
  });

  test("identical plaintext produces different ciphertext (random IV)", () => {
    assert.notEqual(crypto.encrypt("same").value, crypto.encrypt("same").value);
  });

  test("detects tampering instead of returning garbage", () => {
    const enc = crypto.encrypt("important");
    const tampered = { ...enc, value: enc.value.slice(0, -2) + "ff" };
    assert.throws(() => crypto.decrypt(tampered));
  });

  test("rejects malformed ciphertext", () => {
    assert.throws(() => crypto.decrypt({ encrypted: true, value: "not-valid" }));
  });
});

describe("crypto: constant-time comparison", () => {
  test("matches identical strings", () => {
    assert.equal(crypto.safeCompare("abc123", "abc123"), true);
  });
  test("rejects differing strings of equal length", () => {
    assert.equal(crypto.safeCompare("abc123", "abc124"), false);
  });
  test("rejects strings of differing length without throwing", () => {
    assert.equal(crypto.safeCompare("abc", "abcdefghij"), false);
  });
  test("rejects non-string input", () => {
    assert.equal(crypto.safeCompare(null, "abc"), false);
    assert.equal(crypto.safeCompare(undefined, undefined), false);
  });
});

describe("crypto: key generation", () => {
  test("generates prefixed keys of usable length", () => {
    const key = crypto.generateApiKey();
    assert.match(key, /^tpk_/);
    assert.ok(key.length > 24);
  });
  test("generates unique keys", () => {
    const keys = new Set(Array.from({ length: 50 }, () => crypto.generateApiKey()));
    assert.equal(keys.size, 50);
  });
});
