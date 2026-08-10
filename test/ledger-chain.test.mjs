import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Own data directory, set BEFORE the first import that reads it. costTracker
// resolves usage.jsonl from TOLLPIKE_DATA_DIR at module load, and a test that
// let it fall through to the repo's own data/ once overwrote a live encrypted
// gateway key with null. This module also calls recordUsage(), so the
// security-invariants suite requires exactly this isolation.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tollpike-ledger-"));
process.env.TOLLPIKE_DATA_DIR = tmpDir;

const logPath = path.join(tmpDir, "usage.jsonl");
const headPath = path.join(tmpDir, "usage.head");

// Must match GENESIS and canonicalPayload() in costTracker.js. A forged chain
// the attacker builds has to use the same construction, so the test needs its
// own copy to play attacker with.
const GENESIS = "tollpike-ledger-v1";
function canon(row) {
  const keys = Object.keys(row).filter((k) => k !== "h" && row[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + JSON.stringify(row[k])).join(",") + "}";
}
// How an attacker without TOLLPIKE_SECRET would try to re-seal a chain: a bare
// SHA-256, because they cannot compute the HMAC.
function sha256Reseal(rows) {
  let head = GENESIS;
  return rows.map((r) => {
    const { h, ...payload } = r;
    head = crypto.createHash("sha256").update(head + "\n" + canon(payload)).digest("hex");
    return { ...payload, h: head };
  });
}

let ct;
before(async () => {
  ct = await import("../src/storage/costTracker.js");
});

const readRows = () =>
  fs.readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const writeRows = (rows) => fs.writeFileSync(logPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const record = (n, provider = "groq") => {
  for (let i = 0; i < n; i++) {
    ct.recordUsage({
      providerId: provider,
      model: "m",
      usage: { prompt_tokens: 10 + i, completion_tokens: 2 + (i % 3) },
      latencyMs: 100 + i,
      costPer1mTokens: { input: 1, output: 2 }
    });
  }
};

// Fresh ledger + anchor, chosen keying, aggregates rebuilt from the empty file.
const backupPath = logPath + ".pre-seal.bak";

function reset({ keyed }) {
  for (const p of [logPath, headPath, headPath + ".tmp", backupPath, logPath + ".seal.tmp"]) {
    if (fs.existsSync(p)) fs.rmSync(p);
  }
  if (keyed) process.env.TOLLPIKE_SECRET = "ledger-test-secret";
  else delete process.env.TOLLPIKE_SECRET;
  ct.reload();
}

describe("keyed chain (HMAC-SHA256 under TOLLPIKE_SECRET)", () => {
  beforeEach(() => reset({ keyed: true }));

  test("seals every appended row and verifies clean", () => {
    record(5);
    const r = ct.verifyLedger();
    assert.equal(r.keyed, true);
    assert.equal(r.algo, "hmac-sha256");
    assert.equal(r.chained, 5);
    assert.equal(r.unchained, 0);
    assert.equal(r.brokenLinks, 0);
    assert.equal(r.chainOk, true);
    assert.equal(r.intact, true);
    assert.equal(r.anchored, true);
    assert.equal(r.anchorOk, true);
  });

  test("a fresh ledger reports chainOk null, not a false clean bill", () => {
    // reset() already reloaded an empty file.
    const r = ct.verifyLedger();
    assert.equal(r.chained, 0);
    assert.equal(r.chainOk, null, "nothing sealed yet must not read as intact");
  });

  test("detects an edited row and localizes the break", () => {
    record(5);
    assert.equal(ct.verifyLedger().intact, true); // exploit-before

    const rows = readRows();
    rows[2].costUsd = 9.99; // silently inflate one row's spend
    writeRows(rows);

    const r = ct.verifyLedger(); // exploit-after
    assert.equal(r.intact, false);
    assert.ok(r.brokenLinks >= 1);
    assert.ok(r.brokenAt.includes(2), `break should point at row 2, got ${r.brokenAt}`);
  });

  test("detects a reordered pair", () => {
    record(5);
    const rows = readRows();
    [rows[1], rows[2]] = [rows[2], rows[1]];
    writeRows(rows);
    assert.equal(ct.verifyLedger().intact, false);
  });

  test("detects an interior deletion", () => {
    record(5);
    const rows = readRows();
    rows.splice(2, 1); // drop a row from the middle
    writeRows(rows);
    assert.equal(ct.verifyLedger().intact, false);
  });

  test("detects truncation of recent rows through the anchor", () => {
    record(5);
    const rows = readRows();
    writeRows(rows.slice(0, 3)); // delete the last two, leave the anchor claiming five
    const r = ct.verifyLedger();
    assert.equal(r.truncated, true);
    assert.equal(r.intact, false);
  });

  test("a full re-seal with the wrong primitive is rejected without the key", () => {
    record(3);
    // Attacker rewrites history and re-seals with SHA-256, the best they can do
    // without TOLLPIKE_SECRET. Every row now fails the HMAC check.
    const rows = readRows();
    rows[0].costUsd = 0.5;
    writeRows(sha256Reseal(rows));
    const r = ct.verifyLedger();
    assert.equal(r.intact, false);
    assert.equal(r.brokenLinks, 3, "every row must fail against the keyed MAC");
  });

  test("a forged anchor (no valid tag) is rejected", () => {
    record(3);
    fs.writeFileSync(
      headPath,
      JSON.stringify({ v: 1, count: 3, head: "de".repeat(32), tag: "0".repeat(64) })
    );
    const r = ct.verifyLedger();
    assert.equal(r.anchorOk, false);
    assert.equal(r.intact, false);
  });

  test("a lagging anchor (crash between row write and anchor write) is benign", () => {
    record(2);
    const laggingAnchor = fs.readFileSync(headPath, "utf-8"); // a valid count-2 anchor
    record(1); // anchor now records three
    fs.writeFileSync(headPath, laggingAnchor); // roll the anchor back to two, file still has three

    const r = ct.verifyLedger();
    assert.equal(r.truncated, false, "file longer than the anchor is a pending append, not a deletion");
    assert.equal(r.rolledBack, false);
    assert.equal(r.intact, true);
  });
});

describe("unkeyed chain (no TOLLPIKE_SECRET)", () => {
  beforeEach(() => reset({ keyed: false }));

  test("reports keyed:false and a bare SHA-256, and still chains", () => {
    record(3);
    const r = ct.verifyLedger();
    assert.equal(r.keyed, false);
    assert.equal(r.algo, "sha256");
    assert.equal(r.chainOk, true);
  });

  test("still catches a naive edit at the row itself", () => {
    record(3);
    const rows = readRows();
    rows[1].costUsd = 42; // change content but leave the stored hash
    writeRows(rows);
    assert.equal(ct.verifyLedger().intact, false);
  });

  test("a full re-seal IS undetectable unkeyed, the documented limitation", () => {
    // This is why keyed mode exists. With no secret, the chain function is a
    // plain SHA-256 the attacker can also compute, so re-sealing the whole
    // tail and rewriting the (tag-less) anchor leaves a self-consistent ledger.
    // Asserting the gap honestly, rather than pretending unkeyed is tamperproof.
    record(3);
    const rows = readRows();
    rows[0].costUsd = 0.5;
    const resealed = sha256Reseal(rows);
    writeRows(resealed);
    fs.writeFileSync(
      headPath,
      JSON.stringify({ v: 1, count: 3, head: resealed[resealed.length - 1].h })
    );
    assert.equal(ct.verifyLedger().intact, true, "unkeyed cannot detect a competent re-seal");
  });
});

describe("pre-chain (legacy) rows predating the feature", () => {
  beforeEach(() => reset({ keyed: true }));

  test("legacy rows are counted as unchained, not as damage, and new rows chain", () => {
    // Rows written before this feature carry no `h`.
    const legacy = [
      { ts: "2026-01-01T00:00:00.000Z", providerId: "groq", model: "m", promptTokens: 1, completionTokens: 1, costUsd: 0, latencyMs: 1 },
      { ts: "2026-01-01T00:00:01.000Z", providerId: "groq", model: "m", promptTokens: 1, completionTokens: 1, costUsd: 0, latencyMs: 1 },
      { ts: "2026-01-01T00:00:02.000Z", providerId: "groq", model: "m", promptTokens: 1, completionTokens: 1, costUsd: 0, latencyMs: 1 }
    ];
    writeRows(legacy);
    ct.reload();
    record(2); // new rows chain from GENESIS on top of the legacy prefix

    const r = ct.verifyLedger();
    assert.equal(r.unchained, 3);
    assert.equal(r.chained, 2);
    assert.equal(r.brokenLinks, 0);
    assert.equal(r.intact, true);
  });

  test("a no-hash row appearing after the chain has begun is a break", () => {
    record(2);
    const rows = readRows();
    // Splice a hashless row into the middle of the sealed chain.
    rows.splice(1, 0, { ts: "2026-01-01T00:00:00.000Z", providerId: "x", model: "m", promptTokens: 0, completionTokens: 0, costUsd: 0, latencyMs: 0 });
    writeRows(rows);
    assert.equal(ct.verifyLedger().intact, false);
  });
});

describe("integrity travels through getUsageSummary()", () => {
  beforeEach(() => reset({ keyed: true }));

  test("the summary carries the load-time snapshot", () => {
    record(3);
    ct.reload();
    const integrity = ct.getUsageSummary().integrity;
    assert.equal(integrity.chained, 3);
    assert.equal(integrity.chainOk, true);
  });

  test("an append advances the snapshot without a reload", () => {
    assert.equal(ct.getUsageSummary().integrity.chainOk, null); // empty after reset
    record(1);
    const integrity = ct.getUsageSummary().integrity;
    assert.equal(integrity.chained, 1);
    assert.equal(integrity.chainOk, true);
  });

  test("the returned snapshot is a copy, not the live aggregate", () => {
    record(2);
    const first = ct.getUsageSummary().integrity;
    first.chained = 999;
    first.brokenAt.push(123);
    assert.equal(ct.getUsageSummary().integrity.chained, 2, "mutating the copy must not corrupt state");
  });
});

describe("sealLedger(), the --seal backfill", () => {
  const legacyRow = (ts) => ({
    ts, providerId: "groq", model: "m", promptTokens: 5, completionTokens: 1, costUsd: 0.0001, latencyMs: 7
  });

  beforeEach(() => reset({ keyed: true }));

  test("seals a pre-chain prefix into the chain, preserves payloads, keeps a backup", () => {
    writeRows([legacyRow("2026-01-01T00:00:00.000Z"), legacyRow("2026-01-01T00:00:01.000Z"), legacyRow("2026-01-01T00:00:02.000Z")]);
    ct.reload();
    record(2); // 3 unchained + 2 chained
    assert.equal(ct.verifyLedger().unchained, 3);

    const preSeal = fs.readFileSync(logPath, "utf-8");
    const s = ct.sealLedger();
    assert.equal(s.ok, true);
    assert.equal(s.sealed, 3);
    assert.equal(s.total, 5);
    assert.equal(s.keyed, true);

    const after = ct.verifyLedger();
    assert.equal(after.unchained, 0, "the prefix is now part of the chain");
    assert.equal(after.chained, 5);
    assert.equal(after.intact, true);

    // Payloads survive untouched: only `h` is added.
    const rows = readRows();
    assert.equal(rows[0].ts, "2026-01-01T00:00:00.000Z");
    assert.equal(rows[0].costUsd, 0.0001);
    assert.ok(typeof rows[0].h === "string");

    assert.ok(fs.existsSync(backupPath), "a backup must be written");
    assert.equal(fs.readFileSync(backupPath, "utf-8"), preSeal, "the backup is the exact pre-seal file");
  });

  test("is a no-op when the ledger is already fully chained", () => {
    record(3);
    const s = ct.sealLedger();
    assert.equal(s.ok, true);
    assert.equal(s.sealed, 0);
  });

  test("refuses to seal a tampered ledger and leaves the file untouched", () => {
    record(3);
    const rows = readRows();
    rows[1].costUsd = 100;
    writeRows(rows);
    const tamperedContent = fs.readFileSync(logPath, "utf-8");

    const s = ct.sealLedger();
    assert.equal(s.ok, false);
    assert.equal(s.reason, "verification-failed");
    assert.equal(fs.readFileSync(logPath, "utf-8"), tamperedContent, "must not rewrite over the evidence");
    assert.equal(fs.existsSync(backupPath), false, "no backup on a refusal");
  });

  test("refuses when the ledger has unparsable lines", () => {
    record(2);
    fs.appendFileSync(logPath, "this is not json\n");
    const s = ct.sealLedger();
    assert.equal(s.ok, false);
    assert.equal(s.reason, "unparsable-lines");
    assert.equal(s.unparsable, 1);
  });
});
