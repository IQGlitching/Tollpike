import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Own data directory. quotaTracker persists to <dataDir>/quota.json, and
// sharing ./data with the e2e suite is exactly the isolation bug the handover
// documents — the file vanishes mid-suite and correct assertions fail.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tollpike-quota-"));
process.env.TOLLPIKE_DATA_DIR = tmpDir;

let quota;
let registry;

before(async () => {
  registry = await import("../src/providers/registry.js");
  quota = await import("../src/storage/quotaTracker.js");
});

beforeEach(() => quota.resetQuota());

describe("free quota: declarations", () => {
  test("reads a declared free tier from provider config", () => {
    const tier = quota.freeTierOf(registry.getProvider("groq"));
    assert.ok(tier);
    assert.equal(tier.pool, "groq-free");
    assert.equal(tier.requestsPerMinute, 30);
  });

  test("a metered provider has no free tier", () => {
    assert.equal(quota.freeTierOf(registry.getProvider("anthropic")), null);
    assert.equal(quota.isFreeTier(registry.getProvider("anthropic")), false);
  });

  test("a free tier declaring no limits is not a declaration", () => {
    // The half-filled block you write first from the vendor's docs. It is not
    // the legacy boolean, so the typeof guard passed it, every limit came out
    // null, `declared` was empty and headroom fell back to 1.0: the lane
    // advertised completely unused free capacity that nobody could count, and
    // quota-headroom and drain-free would route to it preferentially.
    const halfFilled = { id: "probe", freeTier: { pool: "probe-free", poolConfidence: "known" } };
    assert.equal(quota.freeTierOf(halfFilled), null, "no limits means no declaration");
    assert.equal(quota.isFreeTier(halfFilled), false);
  });

  test("undeclaredFreeTiers reports every shape freeTierOf refused", () => {
    // Derived from freeTierOf rather than re-testing the shape, so the two
    // cannot drift. They did: the limitless-object case was missing from this
    // list while simultaneously reporting full headroom.
    const undeclared = quota.undeclaredFreeTiers();
    for (const p of registry.providers) {
      if (!p.freeTier) continue;
      const refused = quota.freeTierOf(p) === null;
      assert.equal(
        undeclared.includes(p.id),
        refused,
        `${p.id}: refused=${refused} but listed=${undeclared.includes(p.id)}`
      );
    }
  });

  test("every shipped free tier is marked unverified", () => {
    // Same discipline as pricingVerified. A published limit nobody checked
    // against a real account must never present itself as confirmed.
    for (const provider of registry.providers.filter(quota.isFreeTier)) {
      assert.equal(
        quota.freeTierOf(provider).limitsVerified,
        false,
        `${provider.id} claims verified limits`
      );
    }
  });

  test("readings always say they are observation-only", () => {
    // The gateway cannot see usage of the same key from another client, so
    // real remaining quota is always this or less. Dropping this flag is how
    // an estimate starts reading as a fact.
    assert.equal(quota.quotaStatus("groq").observedOnly, true);
    assert.equal(quota.quotaSnapshot().observedOnly, true);
  });
});

describe("free quota: counting", () => {
  test("counts a request against the minute and the day", () => {
    quota.recordFreeUsage("groq", { tokens: 100 });
    const status = quota.quotaStatus("groq");
    assert.equal(status.used.requestsThisMinute, 1);
    assert.equal(status.used.requestsToday, 1);
    assert.equal(status.used.tokensThisMinute, 100);
    assert.equal(status.remaining.requestsThisMinute, 29);
  });

  test("ignores providers with no declared free tier", () => {
    assert.equal(quota.recordFreeUsage("anthropic", { tokens: 100 }), null);
    assert.equal(quota.quotaStatus("anthropic"), null);
  });

  test("headroom is governed by the tightest declared limit", () => {
    // groq: 30 rpm, 6000 tpm. 3000 tokens is half the token budget but only
    // 1/30th of the request budget, so headroom must report 0.5.
    quota.recordFreeUsage("groq", { tokens: 3000 });
    assert.equal(quota.quotaStatus("groq").headroom, 0.5);
  });

  test("exhausts when any single limit hits zero", () => {
    for (let i = 0; i < 30; i++) quota.recordFreeUsage("groq", { tokens: 1 });
    const status = quota.quotaStatus("groq");
    assert.equal(status.remaining.requestsThisMinute, 0);
    assert.ok(status.remaining.tokensThisMinute > 0); // tokens left, requests not
    assert.equal(status.exhausted, true);
    assert.equal(status.headroom, 0);
  });

  test("remaining never goes negative", () => {
    for (let i = 0; i < 45; i++) quota.recordFreeUsage("groq", { tokens: 1 });
    assert.equal(quota.quotaStatus("groq").remaining.requestsThisMinute, 0);
  });
});

describe("free quota: pool dedup", () => {
  test("providers sharing a pool share one counter", () => {
    // No two shipped entries are known to share an upstream allowance, so
    // this declares one to exercise the machinery. Mutating the registry is
    // safe here: node:test runs each file in its own process.
    const a = registry.getProvider("groq");
    const b = registry.getProvider("cerebras");
    const originalA = a.freeTier;
    const originalB = b.freeTier;
    a.freeTier = { pool: "shared", poolConfidence: "known", requestsPerMinute: 10 };
    b.freeTier = { pool: "shared", poolConfidence: "known", requestsPerMinute: 10 };
    quota.resetQuota();

    try {
      quota.recordFreeUsage("groq", { tokens: 0 });
      quota.recordFreeUsage("groq", { tokens: 0 });

      // Spending on one member consumes the other's view of the same pool.
      // Counting per gateway-entry here would report 10 remaining on cerebras
      // and hand out quota that does not exist.
      assert.equal(quota.quotaStatus("cerebras").used.requestsThisMinute, 2);
      assert.equal(quota.quotaStatus("cerebras").remaining.requestsThisMinute, 8);
      assert.deepEqual(quota.quotaStatus("groq").poolMembers.sort(), ["cerebras", "groq"]);

      const snap = quota.quotaSnapshot();
      const shared = snap.pools.find((p) => p.pool === "shared");
      assert.equal(shared.members.length, 2);
      assert.ok(snap.totals.dedupedAway >= 1, "dedup must be reported, not hidden");
    } finally {
      a.freeTier = originalA;
      b.freeTier = originalB;
      quota.resetQuota();
    }
  });

  test("snapshot reports pool confidence and unverified limits honestly", () => {
    const snap = quota.quotaSnapshot();
    assert.equal(snap.totals.declaredFreeProviders, snap.providers.length);
    assert.equal(snap.totals.distinctPools, snap.pools.length);
    assert.equal(
      snap.totals.dedupedAway,
      snap.providers.length - snap.pools.length,
      "dedupedAway must be the real gap between entries and pools"
    );
    assert.equal(snap.totals.unverifiedLimits, snap.providers.length);
    assert.ok(snap.totals.assumedPools > 0);
  });
});

describe("free quota: persistence", () => {
  test("survives a reload from disk", async () => {
    quota.recordFreeUsage("groq", { tokens: 42 });
    quota.flushQuota();
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, "quota.json"), "utf-8"));
    // Spent quota that a restart forgets is quota the gateway hands out
    // twice, and the vendor then rejects the second half.
    assert.equal(onDisk.pools["groq-free"].requests.length, 1);
    assert.equal(onDisk.pools["groq-free"].tokens[0][1], 42);
  });
});
