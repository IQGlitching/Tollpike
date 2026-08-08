// Migration that added the metadata the routing strategies and the free-quota
// tracker need to config/providers.json. ALREADY APPLIED — kept as provenance,
// because `_note` in that file points here to say where the values came from.
//
// ⚠ RE-RUNNING IS DESTRUCTIVE TO VERIFICATION WORK. It rewrites every
// `freeTier` block and stamps `limitsVerified: false` unconditionally, so it
// would silently undo any limit you have since confirmed against a real
// account — which is the one piece of work here that cannot be redone from
// documentation. It exits unless you pass --force.
//
// The three fields it added:
//
//   billing        "metered" | "free-tier" | "local". Drives the drain
//                  strategies. Subscription coverage is NOT set here — only
//                  the operator knows what they pay for, so that lives in
//                  settings.subscriptionProviders.
//   freeTier       declared free allowance + pool id. Unverified by
//                  construction: these are the vendors' published shapes.
//   contextWindow  headline context length. Needed by the context-aware
//                  strategy, which has to know what fits before it can keep a
//                  long context on a model that can hold it.

import fs from "node:fs";
import path from "node:path";

if (!process.argv.includes("--force")) {
  console.error(
    "This migration has already been applied to config/providers.json.\n" +
      "Re-running resets freeTier.limitsVerified to false on every provider, discarding\n" +
      "any limit you have verified against a real account.\n\n" +
      "Pass --force if that is genuinely what you want."
  );
  process.exit(1);
}

const configPath = path.join(import.meta.dirname, "..", "config", "providers.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

// Published free-tier shapes. Every one is unverified against a real account —
// that is what limitsVerified: false means, and the panel says so. Pool ids are
// per-vendor: none of the 36 entries is known to share an upstream allowance
// with another, so declaring a shared pool would be inventing a relationship.
// poolConfidence records which of those it is.
const FREE_TIERS = {
  gemini: { pool: "google-ai-studio", poolConfidence: "known", requestsPerMinute: 15, requestsPerDay: 1500, tokensPerMinute: 1_000_000, resetsAt: "00:00Z" },
  groq: { pool: "groq-free", poolConfidence: "known", requestsPerMinute: 30, requestsPerDay: 14_400, tokensPerMinute: 6_000, resetsAt: "00:00Z" },
  cerebras: { pool: "cerebras-free", poolConfidence: "known", requestsPerMinute: 30, requestsPerDay: 14_400, tokensPerMinute: 60_000, resetsAt: "00:00Z" },
  openrouter: { pool: "openrouter-free", poolConfidence: "known", requestsPerMinute: 20, requestsPerDay: 50, resetsAt: "00:00Z" },
  mistral: { pool: "mistral-free", poolConfidence: "assumed", requestsPerMinute: 60, requestsPerDay: 500_000, resetsAt: "00:00Z" },
  githubmodels: { pool: "github-models-free", poolConfidence: "known", requestsPerMinute: 15, requestsPerDay: 150, resetsAt: "00:00Z" },
  huggingface: { pool: "hf-inference-free", poolConfidence: "assumed", requestsPerDay: 1_000, resetsAt: "00:00Z" },
  nvidia: { pool: "nvidia-nim-free", poolConfidence: "assumed", requestsPerMinute: 40, requestsPerDay: 1_000, resetsAt: "00:00Z" },
  cohere: { pool: "cohere-trial", poolConfidence: "known", requestsPerMinute: 20, requestsPerDay: 1_000, resetsAt: "00:00Z" },
  chutes: { pool: "chutes-free", poolConfidence: "assumed", requestsPerDay: 200, resetsAt: "00:00Z" },
  zhipu: { pool: "zhipu-free", poolConfidence: "assumed", requestsPerMinute: 20, requestsPerDay: 1_000, resetsAt: "00:00Z" },
  dashscope: { pool: "dashscope-free", poolConfidence: "assumed", requestsPerMinute: 20, requestsPerDay: 1_000, resetsAt: "00:00Z" },
  sambanova: { pool: "sambanova-free", poolConfidence: "assumed", requestsPerMinute: 20, requestsPerDay: 1_000, resetsAt: "00:00Z" }
};

// Headline context windows. Unverified in the same sense as the free tiers.
const CONTEXT = {
  anthropic: 200_000, openai: 128_000, gemini: 1_048_576, deepseek: 128_000,
  groq: 128_000, cerebras: 128_000, together: 128_000, fireworks: 128_000,
  mistral: 128_000, openrouter: 128_000, xai: 256_000, perplexity: 128_000,
  nvidia: 128_000, deepinfra: 128_000, hyperbolic: 128_000, sambanova: 64_000,
  novita: 128_000, nebius: 128_000, moonshot: 256_000, zhipu: 128_000,
  dashscope: 128_000, githubmodels: 128_000, huggingface: 32_000, cohere: 128_000,
  upstage: 32_000, aimlapi: 128_000, featherless: 32_000, chutes: 128_000,
  baseten: 128_000, inferencenet: 128_000, ollama: 8_192, lmstudio: 8_192,
  vllm: 8_192, llamacpp: 8_192, jan: 8_192, textgenwebui: 8_192
};

let patched = 0;
for (const provider of config.providers) {
  const isLocal = provider.category === "local" || provider.requiresKey === false;
  provider.billing = isLocal ? "local" : FREE_TIERS[provider.id] ? "free-tier" : "metered";

  if (FREE_TIERS[provider.id]) {
    provider.freeTier = { ...FREE_TIERS[provider.id], limitsVerified: false };
  }
  if (CONTEXT[provider.id]) {
    provider.contextWindow = CONTEXT[provider.id];
    provider.contextVerified = false;
  }
  patched++;
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
console.log(`patched ${patched} providers`);
console.log(`  free tiers declared: ${Object.keys(FREE_TIERS).length}`);
console.log(`  distinct free pools: ${new Set(Object.values(FREE_TIERS).map((t) => t.pool)).size}`);
console.log("  every limitsVerified reset to false — re-verify anything you had confirmed");
