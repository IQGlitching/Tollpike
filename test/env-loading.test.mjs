import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// src/env.js decides where credentials come from, so its resolution order is a
// security property rather than a convenience: getting it backwards would make
// a project-local .env silently override the protected one, quietly undoing the
// reason the secrets were moved out of the repo in the first place.
//
// Loading happens as a module side effect at import time, which cannot be
// re-run inside one process. Each case therefore runs in a child process with a
// purpose-built environment, and asserts on what that child actually resolved.

const root = path.join(import.meta.dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tollpike-env-"));

// Reports the resolved value without ever printing it to a shared log.
// A file:// URL, not a bare path: on Windows an absolute path like C:/... is
// rejected by the ESM loader as an unsupported URL scheme.
const PROBE = `
import { envStatus } from ${JSON.stringify(pathToFileURL(path.join(root, "src", "env.js")).href)};
console.log(JSON.stringify({
  status: envStatus(),
  probe: process.env.TOLLPIKE_TEST_PROBE ?? null,
  secret: process.env.TOLLPIKE_SECRET ?? null
}));
`;
const probePath = path.join(tmp, "probe.mjs");
fs.writeFileSync(probePath, PROBE);

function runProbe({ cwd, env = {} }) {
  const out = execFileSync(process.execPath, [probePath], {
    cwd,
    env: {
      // A clean environment: inheriting the real one would let the developer's
      // own credentials decide the result.
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: env.HOME ?? tmp,
      USERPROFILE: env.USERPROFILE ?? tmp,
      ...env
    },
    encoding: "utf-8"
  });
  return JSON.parse(out.trim().split("\n").pop());
}

const writeEnvFile = (dir, contents) => {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, contents);
  return file;
};

describe("env loading: resolution order", () => {
  test("the project .env is still read when nothing else exists", () => {
    const cwd = fs.mkdtempSync(path.join(tmp, "proj-"));
    writeEnvFile(cwd, "TOLLPIKE_TEST_PROBE=from-project\n");
    const result = runProbe({ cwd });
    assert.equal(result.probe, "from-project");
    assert.ok(result.status.loadedFrom.some((l) => l.source === "project"));
  });

  test("the protected file wins over the project .env", () => {
    const home = fs.mkdtempSync(path.join(tmp, "home-"));
    const cwd = fs.mkdtempSync(path.join(tmp, "proj-"));
    writeEnvFile(path.join(home, ".tollpike"), "TOLLPIKE_TEST_PROBE=from-protected\n");
    writeEnvFile(cwd, "TOLLPIKE_TEST_PROBE=from-project\n");

    const result = runProbe({ cwd, env: { HOME: home, USERPROFILE: home } });
    assert.equal(
      result.probe,
      "from-protected",
      "a repo-local .env must never shadow the protected one — that would undo the move"
    );
  });

  test("TOLLPIKE_ENV_FILE beats both", () => {
    const home = fs.mkdtempSync(path.join(tmp, "home-"));
    const cwd = fs.mkdtempSync(path.join(tmp, "proj-"));
    const explicit = path.join(tmp, "explicit.env");
    fs.writeFileSync(explicit, "TOLLPIKE_TEST_PROBE=from-explicit\n");
    writeEnvFile(path.join(home, ".tollpike"), "TOLLPIKE_TEST_PROBE=from-protected\n");
    writeEnvFile(cwd, "TOLLPIKE_TEST_PROBE=from-project\n");

    const result = runProbe({ cwd, env: { HOME: home, USERPROFILE: home, TOLLPIKE_ENV_FILE: explicit } });
    assert.equal(result.probe, "from-explicit");
  });

  // The property the e2e suite's credential isolation rests on. If naming a
  // file merely OUTRANKED the defaults, a home-directory .env would still load
  // — and since it loads regardless of cwd, the test suite would silently run
  // against the developer's real keys and spend their money.
  test("an explicit file suppresses the defaults entirely", () => {
    const home = fs.mkdtempSync(path.join(tmp, "home-"));
    const cwd = fs.mkdtempSync(path.join(tmp, "proj-"));
    const explicit = path.join(tmp, "only.env");
    fs.writeFileSync(explicit, "TOLLPIKE_TEST_PROBE=from-explicit\n");
    writeEnvFile(path.join(home, ".tollpike"), "TOLLPIKE_SECRET=leaked-from-home\n");
    writeEnvFile(cwd, "TOLLPIKE_SECRET=leaked-from-project\n");

    const result = runProbe({ cwd, env: { HOME: home, USERPROFILE: home, TOLLPIKE_ENV_FILE: explicit } });
    assert.equal(result.secret, null, "no variable from either default file may leak through");
    assert.deepEqual(result.status.loadedFrom.map((l) => l.source), ["TOLLPIKE_ENV_FILE"]);
  });

  test("pointing at a nonexistent file yields no credentials at all", () => {
    const home = fs.mkdtempSync(path.join(tmp, "home-"));
    const cwd = fs.mkdtempSync(path.join(tmp, "proj-"));
    writeEnvFile(path.join(home, ".tollpike"), "TOLLPIKE_SECRET=leaked-from-home\n");
    writeEnvFile(cwd, "TOLLPIKE_TEST_PROBE=leaked-from-project\n");

    const result = runProbe({
      cwd,
      env: { HOME: home, USERPROFILE: home, TOLLPIKE_ENV_FILE: path.join(tmp, "does-not-exist.env") }
    });
    assert.equal(result.secret, null);
    assert.equal(result.probe, null);
    assert.deepEqual(result.status.loadedFrom, [], "nothing was loaded");
  });

  test("a real environment variable beats every file", () => {
    // This is what keeps `docker run -e`, systemd and CI working.
    const home = fs.mkdtempSync(path.join(tmp, "home-"));
    const cwd = fs.mkdtempSync(path.join(tmp, "proj-"));
    writeEnvFile(path.join(home, ".tollpike"), "TOLLPIKE_TEST_PROBE=from-protected\n");

    const result = runProbe({
      cwd,
      env: { HOME: home, USERPROFILE: home, TOLLPIKE_TEST_PROBE: "from-environment" }
    });
    assert.equal(result.probe, "from-environment");
  });

  test("files layer rather than replace: each variable resolves independently", () => {
    const home = fs.mkdtempSync(path.join(tmp, "home-"));
    const cwd = fs.mkdtempSync(path.join(tmp, "proj-"));
    writeEnvFile(path.join(home, ".tollpike"), "TOLLPIKE_SECRET=secret-from-protected\n");
    writeEnvFile(cwd, "TOLLPIKE_TEST_PROBE=port-from-project\n");

    const result = runProbe({ cwd, env: { HOME: home, USERPROFILE: home } });
    assert.equal(result.secret, "secret-from-protected", "the secret comes from the protected file");
    assert.equal(result.probe, "port-from-project", "non-secret settings still come from the project file");
    assert.equal(result.status.loadedFrom.length, 2, "both files contribute");
  });

  test("a missing project .env is not an error", () => {
    const cwd = fs.mkdtempSync(path.join(tmp, "empty-"));
    assert.doesNotThrow(() => runProbe({ cwd }));
  });
});

describe("env loading: status reporting", () => {
  test("reports whether a secret is configured, never its value", () => {
    const home = fs.mkdtempSync(path.join(tmp, "home-"));
    writeEnvFile(path.join(home, ".tollpike"), "TOLLPIKE_SECRET=super-secret-value\n");
    const cwd = fs.mkdtempSync(path.join(tmp, "proj-"));

    const result = runProbe({ cwd, env: { HOME: home, USERPROFILE: home } });
    assert.equal(result.status.secretConfigured, true);
    assert.ok(
      !JSON.stringify(result.status).includes("super-secret-value"),
      "envStatus() must expose presence and paths only"
    );
  });

  test("secretConfigured is false when no secret is set", () => {
    const cwd = fs.mkdtempSync(path.join(tmp, "proj-"));
    assert.equal(runProbe({ cwd }).status.secretConfigured, false);
  });
});

describe("env loading: wiring", () => {
  const server = fs.readFileSync(path.join(root, "src", "server.js"), "utf-8");

  test("env.js is imported before anything that reads process.env", () => {
    // providers/registry.js reads process.env at module scope, and ES module
    // imports evaluate in source order — so this ordering is load-bearing.
    const envAt = server.indexOf('from "./env.js"');
    const registryAt = server.indexOf('from "./providers/registry.js"');
    assert.ok(envAt !== -1, "server.js must load credentials through env.js");
    assert.ok(registryAt !== -1);
    assert.ok(envAt < registryAt, "credentials must be loaded before the registry reads them");
  });

  test("no module still uses the bare dotenv/config side-effect import", () => {
    // Matches a real statement, not a mention in prose — src/env.js documents
    // what it replaced, and that comment is not a regression.
    const BARE_IMPORT = /^\s*(?:import\s+["']dotenv\/config["']|(?:const|let|var)\s.*require\(["']dotenv\/config["']\))/m;
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|mjs)$/.test(entry.name)) {
          if (BARE_IMPORT.test(fs.readFileSync(full, "utf-8"))) offenders.push(full);
        }
      }
    };
    walk(path.join(root, "src"));
    walk(path.join(root, "scripts"));
    assert.deepEqual(
      offenders.map((f) => path.relative(root, f)),
      [],
      "dotenv/config only reads ./.env — it would miss the protected file entirely"
    );
  });
});
