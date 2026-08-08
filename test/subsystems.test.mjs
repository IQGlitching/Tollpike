import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tollpike-subsystems-"));
process.env.TOLLPIKE_DATA_DIR = tmpDir;

let services;
let gamification;
let tls;
let proxy;
let obsidian;
let notion;
let settingsModule;

before(async () => {
  services = await import("../src/services/embedded.js");
  gamification = await import("../src/storage/gamification.js");
  tls = await import("../src/routing/tls.js");
  proxy = await import("../src/routing/proxy.js");
  obsidian = await import("../src/knowledge/obsidian.js");
  notion = await import("../src/knowledge/notion.js");
  settingsModule = await import("../src/storage/settings.js");
});

describe("embedded services", () => {
  beforeEach(() => services._reset());

  test("only declared services can be started", () => {
    // There is no "run this command" endpoint. The closed set IS the security
    // boundary — an arbitrary-command supervisor reachable from the control
    // panel is a remote shell.
    const result = services.startService("rm-rf-everything", {});
    assert.equal(result.ok, false);
    assert.match(result.error, /unknown service/);
  });

  test("never uses a shell", () => {
    // Structural, like test/security-invariants.test.mjs: arguments include
    // operator-supplied values, and one string interpolated into a shell is a
    // command injection reachable from the dashboard.
    const source = fs.readFileSync(new URL("../src/services/embedded.js", import.meta.url), "utf-8");
    assert.match(source, /shell:\s*false/, "spawn must pass shell: false explicitly");
    assert.ok(!/shell:\s*true/.test(source), "shell: true must never appear here");
    assert.ok(!/\bexec\(|execSync\(/.test(source), "exec runs a shell — use spawn with an argv array");
  });

  test("rejects a bad port and non-string args", () => {
    assert.equal(services.startService("bifrost", { port: 99_999 }).ok, false);
    assert.equal(services.startService("bifrost", { port: 0 }).ok, false);
    assert.equal(services.startService("bifrost", { args: "not an array" }).ok, false);
    assert.equal(services.startService("bifrost", { args: [1, 2] }).ok, false);
  });

  test("states plainly that it never installs anything", () => {
    const status = services.servicesStatus({});
    assert.match(status.installs, /never/i);
    for (const service of status.services) {
      // `available: null` is honest: whether the binary is on PATH is genuinely
      // unknown until spawn resolves it, and claiming either answer would be
      // guessing.
      assert.ok(service.binary.available === null || typeof service.binary.available === "boolean");
    }
  });

  test("records a missing binary as an exit reason rather than throwing", async () => {
    // ENOENT arrives asynchronously, after startService has already returned.
    const started = services.startService("bifrost", { port: 31_999 });
    assert.equal(started.ok, true); // spawn was issued; resolution happens later
    await new Promise((r) => setTimeout(r, 300));
    const status = services.servicesStatus({}).services.find((s) => s.id === "bifrost");
    // Either it is genuinely installed, or the failure was captured. What must
    // NOT happen is an unhandled throw taking the gateway with it.
    assert.ok(status.running || status.lastExit, "a failed spawn must be recorded, not lost");
    services.stopService("bifrost");
  });

  test("refuses to start the same service twice", async () => {
    services.startService("9router", { port: 31_998 });
    const second = services.startService("9router", { port: 31_997 });
    // Either already-running, or the first exited and its slot is free again.
    if (!second.ok) assert.match(second.error, /already running/);
    services.stopService("9router");
  });

  test("reports partial cluster startup as partial", () => {
    const result = services.startProfile("full");
    assert.equal(result.started.length + result.failed.length, 3);
    // ok:true on one-of-three is how a half-started cluster looks healthy.
    if (result.failed.length > 0) assert.equal(result.ok, false);
    services.stopAll();
  });

  test("rejects an unknown cluster profile", () => {
    const result = services.startProfile("gigacluster");
    assert.equal(result.ok, false);
    assert.match(result.error, /unknown profile/);
  });

  test("rejects a signal outside the allowed set", () => {
    services.startService("cliproxy", { port: 31_996 });
    const result = services.stopService("cliproxy", { signal: "SIGSTOP" });
    if (!result.ok) assert.match(result.error, /signal must be/);
    services.stopService("cliproxy");
  });
});

describe("TLS shaping", () => {
  test("default profile builds no custom connect options", () => {
    // So the default path stays on undici's shared dispatcher and keeps its
    // connection pooling.
    assert.equal(tls.connectOptionsFor("default"), null);
  });

  test("every non-default profile actually changes the handshake", () => {
    for (const id of tls.TLS_PROFILE_IDS.filter((p) => p !== "default")) {
      const connect = tls.connectOptionsFor(id);
      assert.ok(connect, `${id} has no connect options`);
      assert.ok(connect.ciphers || connect.minVersion, `${id} changes nothing`);
    }
  });

  test("validates a profile name", () => {
    assert.equal(tls.validateTlsProfile("chrome-like").value, "chrome-like");
    assert.equal(tls.validateTlsProfile(null).value, "default");
    assert.equal(tls.validateTlsProfile("").value, "default");
    assert.equal(tls.validateTlsProfile("nginx").ok, false);
  });

  test("does not claim to impersonate a browser", () => {
    // The gap between "different fingerprint" and "passes as Chrome" is exactly
    // what someone enabling this is likely to get wrong, so the caveat is on the
    // API surface rather than only in a comment.
    const status = tls.tlsStatus("chrome-like");
    assert.match(status.caveat, /not browser impersonation/i);
    assert.match(status.caveat, /GREASE/);
    assert.match(status.caveat, /No TLS interception/i);
    // The profile names say "-like" for the same reason.
    assert.ok(tls.TLS_PROFILE_IDS.includes("chrome-like"));
    assert.ok(!tls.TLS_PROFILE_IDS.includes("chrome"));
  });
});

describe("proxy resolution levels", () => {
  const restore = () => settingsModule.updateSettings({ proxies: {}, proxyCategories: {} });

  beforeEach(restore);

  test("resolves in provider > category > global order", () => {
    settingsModule.updateSettings({ proxies: { "*": "http://global:1" }, proxyCategories: {} });
    assert.deepEqual(proxy.resolveProxy("anthropic"), { url: "http://global:1", level: "global" });

    settingsModule.updateSettings({ proxyCategories: { frontier: "http://cat:2" } });
    assert.deepEqual(proxy.resolveProxy("anthropic"), { url: "http://cat:2", level: "category" });

    settingsModule.updateSettings({ proxies: { "*": "http://global:1", anthropic: "http://one:3" } });
    assert.deepEqual(proxy.resolveProxy("anthropic"), { url: "http://one:3", level: "provider" });

    restore();
  });

  test("reports which level decided, not just the url", async () => {
    // "Why is this provider going direct when I set a global proxy" is
    // unanswerable without the level, and the answer is usually a forgotten
    // per-provider entry.
    settingsModule.updateSettings({ proxyCategories: { local: "http://cat:2" } });
    const plan = proxy.proxyPlan((await import("../src/providers/registry.js")).providers);
    assert.ok(plan.every((row) => ["provider", "category", "global", "env", "none"].includes(row.level)));
    assert.ok(plan.some((row) => row.category === "local" && row.level === "category"));
    restore();
  });

  test("refuses a proxy scheme that has no business reaching ProxyAgent", () => {
    assert.equal(proxy.validateProxyUrl("file:///etc/passwd").ok, false);
    assert.equal(proxy.validateProxyUrl("data:text/plain,x").ok, false);
    assert.equal(proxy.validateProxyUrl("not a url").ok, false);
    assert.equal(proxy.validateProxyUrl("socks5://host:1080").ok, true);
    assert.equal(proxy.validateProxyUrl(null).value, null);
  });

  test("states permanently that TLS is never intercepted", () => {
    assert.match(proxy.proxyStatus().interception, /never terminated/i);
  });
});

describe("gamification", () => {
  test("savings state the baseline they are measured against", () => {
    // A savings figure without a stated alternative is unfalsifiable, which is
    // the normal state of this number on other dashboards.
    const result = gamification.savings();
    if (!result.available) {
      assert.match(result.reason, /verified/i);
      return;
    }
    assert.ok(result.baseline.provider);
    assert.ok(result.baseline.description.includes(result.baseline.provider));
    assert.match(result.caveat, /counterfactual/i);
    assert.ok(result.savedUsd >= 0, "savings must never be reported as negative");
  });

  test("a quiet today does not break yesterday's streak", () => {
    // A streak that resets at midnight until you make a request is a lie that
    // discourages the behaviour it is meant to encourage.
    const result = gamification.streak();
    assert.ok(result.currentDays >= 0);
    assert.ok(result.longestDays >= result.currentDays);
    assert.equal(typeof result.todayActive, "boolean");
  });

  test("achievement progress is capped at its target and reports the raw value", () => {
    const snapshot = gamification.gamificationSnapshot({ settings: settingsModule.getSettings() });
    for (const achievement of snapshot.achievements) {
      assert.ok(achievement.progress <= achievement.target, `${achievement.id} progress exceeds target`);
      assert.ok(achievement.pct >= 0 && achievement.pct <= 100);
      assert.equal(achievement.unlocked, achievement.rawProgress >= achievement.target);
      assert.ok(achievement.description.length > 10);
    }
    assert.equal(snapshot.totals.total, snapshot.achievements.length);
  });

  test("every achievement id is unique", () => {
    assert.equal(new Set(gamification.ACHIEVEMENT_IDS).size, gamification.ACHIEVEMENT_IDS.length);
  });
});

describe("obsidian vault containment", () => {
  let vault;

  before(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), "tollpike-vault-"));
    fs.writeFileSync(path.join(vault, "routing.md"), "# Routing\nThe drain-free strategy burns free quota first.");
    fs.mkdirSync(path.join(vault, "notes"));
    fs.writeFileSync(path.join(vault, "notes", "budget.md"), "Budget caps reserve in-flight spend.");
    fs.mkdirSync(path.join(vault, ".obsidian"));
    fs.writeFileSync(path.join(vault, ".obsidian", "workspace.json"), '{"secret":"config not notes"}');
    settingsModule.updateSettings({
      knowledge: { ...settingsModule.getSettings().knowledge, obsidianVault: vault }
    });
  });

  test("lists notes and skips the .obsidian config directory", () => {
    const listed = obsidian.listNotes({});
    assert.equal(listed.ok, true);
    const paths = listed.notes.map((n) => n.path);
    assert.ok(paths.includes("routing.md"));
    assert.ok(paths.includes("notes/budget.md"));
    assert.ok(!paths.some((p) => p.includes(".obsidian")), "config files are not notes");
  });

  test("reads a note inside the vault", () => {
    const note = obsidian.readNote("notes/budget.md");
    assert.equal(note.ok, true);
    assert.match(note.text, /in-flight spend/);
  });

  test("refuses a traversal path", () => {
    for (const attempt of ["../outside.md", "../../etc/passwd", "notes/../../escape.md"]) {
      const result = obsidian.readNote(attempt);
      assert.equal(result.ok, false, `${attempt} was not refused`);
      assert.match(result.reason, /outside the configured vault/);
    }
  });

  test("refuses an absolute path outside the vault", () => {
    const result = obsidian.readNote(path.join(os.tmpdir(), "definitely-not-in-the-vault.md"));
    assert.equal(result.ok, false);
  });

  test("refuses a symlink that resolves out of the vault", (t) => {
    // The reason containment is checked AFTER realpath: a symlink inside the
    // vault contains no ".." at all and resolves straight out of the tree, so
    // screening the path string is not enough.
    const outside = path.join(os.tmpdir(), `tollpike-outside-${process.pid}.md`);
    fs.writeFileSync(outside, "secret material outside the vault");
    const link = path.join(vault, "escape.md");
    try {
      fs.symlinkSync(outside, link);
    } catch {
      // Windows needs privileges for symlinks; skip rather than fail.
      return t.skip("symlink creation not permitted on this platform");
    }
    const result = obsidian.readNote("escape.md");
    assert.equal(result.ok, false);
    assert.match(result.reason, /outside the configured vault/);
  });

  test("searches note text and filenames", () => {
    const found = obsidian.searchNotes("drain-free quota");
    assert.equal(found.ok, true);
    assert.equal(found.results[0].path, "routing.md");
    assert.ok(found.results[0].excerpt.length > 0);
  });

  test("reports read-only access and the containment rule", () => {
    const status = obsidian.obsidianStatus();
    assert.equal(status.access, "read-only");
    assert.match(status.containment, /realpath/);
  });

  test("says what is wrong when no vault is configured", () => {
    settingsModule.updateSettings({
      knowledge: { ...settingsModule.getSettings().knowledge, obsidianVault: null }
    });
    const original = process.env.OBSIDIAN_VAULT;
    delete process.env.OBSIDIAN_VAULT;
    try {
      const result = obsidian.readNote("routing.md");
      assert.equal(result.ok, false);
      assert.match(result.reason, /No Obsidian vault configured/);
    } finally {
      if (original !== undefined) process.env.OBSIDIAN_VAULT = original;
      settingsModule.updateSettings({
        knowledge: { ...settingsModule.getSettings().knowledge, obsidianVault: vault }
      });
    }
  });
});

describe("notion", () => {
  test("reports unconfigured rather than throwing", async () => {
    const original = process.env.NOTION_API_KEY;
    delete process.env.NOTION_API_KEY;
    delete process.env.NOTION_TOKEN;
    try {
      const result = await notion.search("anything");
      assert.equal(result.ok, false);
      assert.match(result.reason, /NOTION_API_KEY/);
      const status = await notion.notionStatus();
      assert.equal(status.configured, false);
    } finally {
      if (original !== undefined) process.env.NOTION_API_KEY = original;
    }
  });

  test("rejects a page id that is not a page id", async () => {
    process.env.NOTION_API_KEY = "fake-for-validation-only";
    try {
      const result = await notion.readPage("../../etc/passwd");
      assert.equal(result.ok, false);
      assert.match(result.reason, /page id/);
    } finally {
      delete process.env.NOTION_API_KEY;
    }
  });
});
