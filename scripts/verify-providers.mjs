#!/usr/bin/env node
import "../src/env.js"; // same resolution order as the gateway — see that file
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Turns "this baseURL came from documentation" into "here's what actually
// answered". Every provider config in this repo ships verified:false, and
// the only honest way to change that is to make a real request.
//
// A 401 counts as REACHABLE — it proves the endpoint exists and speaks the
// expected protocol; it just refused our (absent) credential. That's the
// useful signal when you have no key for a provider yet.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, "..", "config", "providers.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

const TIMEOUT_MS = 8000;
const onlyId = process.argv[2];

function probeUrl(provider) {
  // Each family exposes a cheap, side-effect-free listing endpoint.
  if (provider.adapter === "gemini") {
    const key = process.env[provider.apiKeyEnv];
    return `${provider.baseURL}/models${key ? `?key=${key}` : ""}`;
  }
  if (provider.adapter === "anthropic") return `${provider.baseURL}/models`;
  return `${provider.baseURL}/models`;
}

function headers(provider) {
  const key = process.env[provider.apiKeyEnv];
  if (provider.adapter === "anthropic") {
    return { "anthropic-version": "2023-06-01", ...(key ? { "x-api-key": key } : {}) };
  }
  if (provider.adapter === "gemini") return {};
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function classify(status) {
  if (status >= 200 && status < 300) return { label: "OK", verified: true };
  if (status === 401 || status === 403)
    return { label: "REACHABLE (needs key)", verified: true };
  if (status === 404) return { label: "404 — baseURL likely wrong", verified: false };
  if (status === 429) return { label: "REACHABLE (rate limited)", verified: true };
  return { label: `HTTP ${status}`, verified: false };
}

async function verifyOne(provider) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(probeUrl(provider), {
      headers: headers(provider),
      signal: controller.signal
    });
    const { label, verified } = classify(res.status);
    return { id: provider.id, status: res.status, label, verified, ms: Date.now() - started };
  } catch (err) {
    const reason = err.name === "AbortError" ? "timeout" : err.cause?.code || err.message;
    return { id: provider.id, status: null, label: `unreachable (${reason})`, verified: false, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

const targets = config.providers.filter((p) => (onlyId ? p.id === onlyId : true));

if (targets.length === 0) {
  console.error(`No provider matching "${onlyId}"`);
  process.exit(1);
}

console.log(`Verifying ${targets.length} provider endpoint(s)...\n`);

// Bounded concurrency — polite to the endpoints, still fast.
const CONCURRENCY = 6;
const results = [];
for (let i = 0; i < targets.length; i += CONCURRENCY) {
  const batch = targets.slice(i, i + CONCURRENCY);
  results.push(...(await Promise.all(batch.map(verifyOne))));
}

const pad = Math.max(...results.map((r) => r.id.length));
for (const r of results) {
  const mark = r.verified ? "\u001b[32m✓\u001b[0m" : "\u001b[31m✗\u001b[0m";
  console.log(`${mark} ${r.id.padEnd(pad)}  ${String(r.ms).padStart(5)}ms  ${r.label}`);
}

const okCount = results.filter((r) => r.verified).length;
console.log(`\n${okCount}/${results.length} endpoints confirmed reachable.`);

// Write results back so the config reflects reality rather than assumption.
if (!onlyId) {
  const byId = new Map(results.map((r) => [r.id, r.verified]));
  for (const p of config.providers) {
    if (byId.has(p.id)) p.verified = byId.get(p.id);
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log("Updated 'verified' flags in config/providers.json");
}

process.exit(okCount === results.length ? 0 : 1);
