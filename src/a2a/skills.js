// A2A skills.
//
// Six skills, each a coarse capability another agent can invoke. That grain is
// deliberate and it is the difference between A2A and MCP: MCP exposes a
// hundred fine-grained tools to a model that is driving this gateway
// step-by-step, while A2A exposes a handful of outcomes to a PEER agent that
// wants a job done and does not want to learn this gateway's internals.
//
// Skill selection is explicit first, inferred second. `metadata.skillId` names
// a skill directly; otherwise the request text is matched against keywords. An
// unmatched request routes to `smart-routing`, because a peer agent sending
// prose most likely wants a completion — and guessing wrong there costs one
// wasted call, while refusing costs the interaction.

import { routeChatCompletion, buildCandidates } from "../routing/router.js";
import { providers, billingOf, isPricingVerified, priceFor } from "../providers/registry.js";
import { getUsageSummary, getLedger, getMonthlySpend } from "../storage/costTracker.js";
import { quotaSnapshot } from "../storage/quotaTracker.js";
import { getSettings } from "../storage/settings.js";
import * as resilience from "../routing/resilience.js";
import { listCombos, STRATEGY_IDS } from "../routing/strategies.js";
import * as memory from "../memory/index.js";

export const SKILLS = {
  "smart-routing": {
    name: "Smart routing",
    description:
      "Answer a prompt through the gateway's routing chain, with tiered fallback, spend caps and compression applied. Returns the answer plus which lane served it.",
    tags: ["completion", "routing", "fallback"],
    examples: ["Summarise this changelog", "Route this to the cheapest lane that fits 200k tokens"],
    keywords: ["answer", "complete", "summarise", "summarize", "write", "explain", "route", "ask"],
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to ask" },
        model: { type: "string", description: 'Route string: auto, auto/<strategy>, combo/<name>, provider/model' },
        maxTokens: { type: "number" }
      },
      required: ["prompt"]
    },
    async run({ prompt, model = "auto", maxTokens }) {
      const { response, attempts } = await routeChatCompletion({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens
      });
      const winner = attempts.find((a) => a.ok);
      return {
        text: response.choices?.[0]?.message?.content ?? "",
        data: {
          provider: response.provider,
          model: response.model,
          tier: winner?.tier ?? null,
          strategy: winner?.strategy ?? null,
          usage: response.usage,
          usageSource: response.usage_source,
          skippedLanes: attempts.filter((a) => a.skipped).map((a) => ({ provider: a.provider, reason: a.skipped }))
        }
      };
    }
  },

  "quota-report": {
    name: "Quota report",
    description:
      "Report free-tier quota across every declared provider, deduplicated by shared upstream pool, with what is exhausted and what has headroom left.",
    tags: ["quota", "free-tier", "limits"],
    examples: ["How much free quota is left?", "Which free pools are exhausted?"],
    keywords: ["quota", "free", "limit", "remaining", "headroom", "exhausted"],
    inputSchema: { type: "object", properties: {} },
    async run() {
      const snap = quotaSnapshot();
      const exhausted = snap.pools.filter((p) => p.exhausted).map((p) => p.pool);
      const healthiest = [...snap.pools].sort((a, b) => b.headroom - a.headroom)[0];
      return {
        text: [
          `${snap.totals.declaredFreeProviders} providers declare a free tier across ${snap.totals.distinctPools} distinct pools`,
          snap.totals.dedupedAway > 0
            ? `${snap.totals.dedupedAway} entries share a pool with another and are counted once`
            : "no two entries are known to share a pool",
          exhausted.length ? `exhausted: ${exhausted.join(", ")}` : "nothing exhausted",
          healthiest ? `most headroom: ${healthiest.pool} at ${Math.round(healthiest.headroom * 100)}%` : "",
          `${snap.totals.freeRequestsToday} free requests and ${snap.totals.freeTokensToday} free tokens observed today`,
          `${snap.totals.unverifiedLimits} of these limits are unverified against a real account`
        ]
          .filter(Boolean)
          .join(". "),
        data: snap
      };
    }
  },

  discovery: {
    name: "Capability discovery",
    description:
      "Describe what this gateway can reach: providers, models, routing strategies, combos, context windows and which lanes have credentials.",
    tags: ["discovery", "capabilities", "models"],
    examples: ["What models can you reach?", "Which routing strategies do you support?"],
    keywords: ["discover", "capability", "capabilities", "what can you", "models", "providers", "strategies"],
    inputSchema: {
      type: "object",
      properties: { onlyAvailable: { type: "boolean", description: "Only lanes with a key configured" } }
    },
    async run({ onlyAvailable = false }) {
      const settings = getSettings();
      const pool = providers.filter((p) => (onlyAvailable ? p.available : true));
      return {
        text:
          `${pool.length} providers, ${pool.reduce((n, p) => n + p.models.length, 0)} models, ` +
          `${STRATEGY_IDS.length} routing strategies, ${Object.keys(listCombos(settings.combos)).length} combos. ` +
          `${providers.filter((p) => p.available).length} lanes have credentials configured.`,
        data: {
          providers: pool.map((p) => ({
            id: p.id,
            category: p.category,
            billing: billingOf(p, settings.subscriptionProviders),
            models: p.models,
            contextWindow: p.contextWindow ?? null,
            hasKey: p.available
          })),
          strategies: STRATEGY_IDS,
          combos: Object.keys(listCombos(settings.combos)),
          dialects: ["openai-chat", "anthropic-messages", "openai-responses", "ollama"]
        }
      };
    }
  },

  "cost-analysis": {
    name: "Cost analysis",
    description:
      "Analyse spend: totals, per-provider breakdown, month-to-date against caps, and how much of the figure is provider-reported rather than estimated.",
    tags: ["cost", "spend", "budget"],
    examples: ["What have I spent this month?", "Which provider is costing most?"],
    keywords: ["cost", "spend", "spent", "budget", "cheap", "expensive", "invoice", "ledger"],
    inputSchema: { type: "object", properties: { month: { type: "string", description: "YYYY-MM" } } },
    async run({ month }) {
      const usage = getUsageSummary();
      const ledger = getLedger(/^\d{4}-\d{2}$/.test(month || "") ? month : undefined);
      const settings = getSettings();
      const top = ledger.rows[0];
      return {
        text: [
          `$${usage.totalCostUsd.toFixed(6)} across ${usage.totalRequests} requests and ${usage.totalTokens} tokens`,
          top ? `highest this month: ${top.providerId} at $${top.costUsd.toFixed(6)}` : "no spend recorded this month",
          // Never omitted. A spend figure whose provenance is unstated invites
          // being treated as exact when much of it is locally estimated.
          `${usage.confidence.reportedPct}% of that is backed by provider-reported token counts, the rest is estimated`
        ].join(". "),
        data: {
          totals: { costUsd: usage.totalCostUsd, requests: usage.totalRequests, tokens: usage.totalTokens },
          confidence: usage.confidence,
          ledger,
          caps: Object.entries(settings.budgetCapsUsd || {}).map(([id, cap]) => ({
            provider: id,
            capUsd: cap,
            spentUsd: getMonthlySpend(id),
            pricingVerified: isPricingVerified(providers.find((p) => p.id === id) || {})
          })),
          cheapestLane: (() => {
            const ranked = providers
              .filter((p) => p.available && p.models.length)
              .map((p) => ({ id: p.id, blended: (priceFor(p, p.models[0]).input || 0) + (priceFor(p, p.models[0]).output || 0) * 3 }))
              .sort((a, b) => a.blended - b.blended);
            return ranked[0] || null;
          })()
        }
      };
    }
  },

  "health-report": {
    name: "Health report",
    description:
      "Report gateway health: circuit breakers, cooling connections, locked models, and which lanes are currently routable.",
    tags: ["health", "resilience", "status"],
    examples: ["Is anything broken?", "Which providers are circuit-broken right now?"],
    keywords: ["health", "healthy", "status", "broken", "breaker", "down", "failing", "available"],
    inputSchema: { type: "object", properties: {} },
    async run() {
      const snap = resilience.snapshot();
      const settings = getSettings();
      const open = Object.entries(snap.providers).filter(([, v]) => v.status === "OPEN").map(([id]) => id);
      const routable = providers.filter(
        (p) => p.available && !settings.disabledProviders.includes(p.id) && resilience.isProviderAvailable(p.id)
      );
      return {
        text: [
          `${routable.length} of ${providers.length} lanes are routable right now`,
          open.length ? `circuit open: ${open.join(", ")}` : "no open circuits",
          `${Object.keys(snap.connections || {}).length} connections cooling down`,
          `${Object.keys(snap.models || {}).length} models locked out`
        ].join(". "),
        data: {
          routable: routable.map((p) => p.id),
          openCircuits: open,
          resilience: snap,
          disabled: settings.disabledProviders
        }
      };
    }
  },

  "memory-recall": {
    name: "Memory recall",
    description:
      "Search the gateway's persistent conversational memory with hybrid keyword and vector recall, reporting which halves actually ran.",
    tags: ["memory", "recall", "search"],
    examples: ["What did we decide about the fallback order?", "Recall anything about budget caps"],
    keywords: ["remember", "recall", "memory", "earlier", "previously", "what did we"],
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        sessionId: { type: "string" },
        limit: { type: "number" }
      },
      required: ["query"]
    },
    async run({ query, sessionId = "a2a", limit = 6 }) {
      const found = await memory.recall(query, {
        sessionId,
        limit: Math.min(Math.max(Number(limit) || 6, 1), 50),
        mode: getSettings().memory.recall
      });
      return {
        text: found.results.length
          ? found.results.map((r) => `[${r.role}] ${r.text.slice(0, 400)}`).join("\n")
          : "Nothing recalled for that query.",
        data: {
          results: found.results,
          used: found.used,
          degraded: found.degraded,
          // A peer agent acting on recall needs to know whether it got half the
          // search. "hybrid" that silently ran keyword-only is a wrong answer
          // wearing a right answer's shape.
          complete: found.complete
        }
      };
    }
  }
};

export const SKILL_IDS = Object.keys(SKILLS);

// Explicit id wins; keyword match second; smart-routing as the floor.
export function selectSkill(text, skillId = null) {
  if (skillId) {
    if (!SKILLS[skillId]) {
      throw Object.assign(new Error(`Unknown skill "${skillId}". Available: ${SKILL_IDS.join(", ")}`), {
        code: -32602
      });
    }
    return skillId;
  }

  const haystack = String(text || "").toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const [id, skill] of Object.entries(SKILLS)) {
    const score = skill.keywords.filter((k) => haystack.includes(k)).length;
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best || "smart-routing";
}
