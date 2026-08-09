// MCP tool registry.
//
// Declarative on purpose. A hundred hand-written request handlers is a hundred
// places to forget an input check, and the previous version of this file was
// three tools in a chain of `if (name === ...)` — which does not survive
// growing by two orders of magnitude.
//
// Each scope groups tools over one subsystem. Tool names are `scope_action`
// with underscores, not dots: several MCP clients validate names against
// ^[a-zA-Z0-9_-]{1,64}$ and silently drop anything else, so a dotted name
// disappears from the tool list without an error anywhere.
//
// Two rules that shaped the surface:
//
//   MUTATIONS ARE MARKED. Every tool carries `mutates`. An agent driving this
//   can distinguish reading the gateway's state from changing it, and the HTTP
//   transport can be started read-only.
//
//   NO CREDENTIAL EVER CROSSES THIS BOUNDARY. Not in a response, not in an
//   error. `settings_get` redacts, `settings_patch` refuses to write the
//   gateway key at all, and no tool returns provider key material — the same
//   rule /api/panel/state follows, for the same reason: an agent's transcript
//   is stored, replayed and often shipped to a third party.

import { providers, getProvider, priceFor, isPricingVerified, contextWindowFor, billingOf } from "../providers/registry.js";
import { routeChatCompletion, buildCandidates, publicAttempts } from "../routing/router.js";
import {
  STRATEGIES,
  STRATEGY_IDS,
  STRATEGY_ALIASES,
  listCombos,
  validateCombo,
  comboName,
  orderByStrategy,
  strategyContext,
  FILTER_KEYS,
  MAX_TIERS
} from "../routing/strategies.js";
import * as resilience from "../routing/resilience.js";
import { proxyStatus, proxyPlan, validateProxyUrl, clearAgentCache, resolveProxy } from "../routing/proxy.js";
import { TLS_PROFILE_IDS, validateTlsProfile, tlsStatus } from "../routing/tls.js";
import {
  getUsageSummary,
  getUsageSeries,
  getLedger,
  getMonthlySpend,
  estimateRequestCost
} from "../storage/costTracker.js";
import { quotaSnapshot, quotaStatus, resetQuota, isFreeTier } from "../storage/quotaTracker.js";
import {
  getSettings,
  updateSettings,
  toggleProvider,
  setBudgetCap,
  validateCompression,
  isKeyEncryptedAtRest
} from "../storage/settings.js";
import { gamificationSnapshot, achievements, streak, savings } from "../storage/gamification.js";
import * as cache from "../storage/responseCache.js";
import { applyGuardrails, detectInjection, redactPii } from "../security/guardrails.js";
import { guardRouted, blockedMessage } from "../security/policy.js";
import { generateApiKey, isEncryptionAvailable } from "../security/crypto.js";
import * as rateLimiter from "../middleware/rateLimit.js";
import { compressMessagesWithStats, CAVEMAN_LEVELS, CAVEMAN_SCOPES } from "../compression/compress.js";
import * as memory from "../memory/index.js";
import * as notion from "../knowledge/notion.js";
import * as obsidian from "../knowledge/obsidian.js";
import * as services from "../services/embedded.js";
import * as cloud from "../agents/cloud.js";
import { estimateTokens, promptTextOf } from "../providers/normalize.js";
import { dataDir } from "../paths.js";

const OBJECT = (properties = {}, required = []) => ({ type: "object", properties, required });
const STR = (description) => ({ type: "string", description });
const NUM = (description) => ({ type: "number", description });
const BOOL = (description) => ({ type: "boolean", description });
const ENUM = (values, description) => ({ type: "string", enum: values, description });

// Public provider view. Never includes connections[] — those hold key material.
function publicProvider(p, settings) {
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    billing: billingOf(p, settings.subscriptionProviders),
    models: p.models,
    hasKey: p.available,
    enabled: !settings.disabledProviders.includes(p.id),
    priority: p.priority,
    costPer1mTokens: p.costPer1mTokens,
    pricingVerified: p.pricingVerified ?? false,
    contextWindow: p.contextWindow ?? null,
    freeTier: p.freeTier ? { pool: p.freeTier.pool, limitsVerified: p.freeTier.limitsVerified === true } : null,
    circuit: resilience.snapshot().providers[p.id]?.status || "CLOSED",
    monthlySpendUsd: getMonthlySpend(p.id),
    budgetCapUsd: settings.budgetCapsUsd[p.id] ?? null
  };
}

function requireProvider(id) {
  const provider = getProvider(id);
  if (!provider) throw new Error(`Unknown provider "${id}". Use providers_list to see configured ids.`);
  return provider;
}

// Settings keys a tool may write. Everything absent from this list is
// unreachable through MCP — notably gatewayApiKey, which an agent must never be
// able to set (it would lock the operator out) or clear (it would disable auth).
const PATCHABLE_SETTINGS = new Set([
  "disabledProviders",
  "budgetCapsUsd",
  "proxies",
  "proxyCategories",
  "tlsProfile",
  "combos",
  "defaultCombo",
  "subscriptionProviders",
  "redactPii",
  "injectionMode",
  "quotaTracking",
  "gamification"
]);

function redactedSettings() {
  const settings = getSettings();
  return {
    ...settings,
    // Presence, never the value. Even the length is a hint worth withholding.
    gatewayApiKey: settings.gatewayApiKey ? "<set>" : null,
    memory: { ...settings.memory }
  };
}

export const SCOPES = {
  gateway: {
    description: "Gateway health, endpoints and exposure posture.",
    tools: {
      health: {
        description: "Is the gateway up, and how many providers have a key configured.",
        schema: OBJECT(),
        handler: () => ({
          ok: true,
          providersConfigured: providers.length,
          providersAvailable: providers.filter((p) => p.available).length
        })
      },
      endpoints: {
        description: "Every inbound endpoint this gateway serves, by wire format.",
        schema: OBJECT(),
        handler: () => ({
          openaiChat: "/v1/chat/completions",
          anthropicMessages: "/v1/messages",
          openaiResponses: "/v1/responses",
          ollama: ["/api/chat", "/api/tags"],
          models: "/v1/models",
          mcp: { stdio: "node src/mcp/server.js", http: "/mcp", sse: "/mcp/sse" },
          a2a: { jsonrpc: "/a2a", agentCard: "/.well-known/agent-card.json" },
          panel: "/panel",
          panelApi: "/api/panel/*"
        })
      },
      version: {
        description: "Gateway version and the runtime it is on.",
        schema: OBJECT(),
        handler: () => ({ name: "tollpike", version: "0.1.0", node: process.version, platform: process.platform })
      },
      posture: {
        description: "Security posture: bind address, whether auth is on, encryption state.",
        schema: OBJECT(),
        handler: () => {
          const settings = getSettings();
          const bind = process.env.BIND_HOST || "127.0.0.1";
          return {
            boundHost: bind,
            loopbackOnly: ["127.0.0.1", "::1", "localhost"].includes(bind),
            gatewayAuthEnabled: Boolean(settings.gatewayApiKey),
            keyEncryptedAtRest: isKeyEncryptedAtRest(),
            encryptionAvailable: isEncryptionAvailable(),
            rateLimit: rateLimiter.getConfig(),
            pathTokensEnabled: process.env.ALLOW_PATH_TOKEN === "true",
            unlistedModelsAllowed: process.env.ALLOW_UNLISTED_MODELS === "true"
          };
        }
      }
    }
  },

  providers: {
    description: "The provider registry: what is configured, what has a key, what is healthy.",
    tools: {
      list: {
        description: "All configured providers with keys, models, health and spend. Never returns key material.",
        schema: OBJECT({
          category: ENUM(["frontier", "inference", "aggregator", "local"], "Filter by category"),
          onlyAvailable: BOOL("Only providers with an API key configured")
        }),
        handler: ({ category, onlyAvailable }) => {
          const settings = getSettings();
          return providers
            .filter((p) => (category ? p.category === category : true))
            .filter((p) => (onlyAvailable ? p.available : true))
            .map((p) => publicProvider(p, settings));
        }
      },
      get: {
        description: "One provider in full detail.",
        schema: OBJECT({ id: STR("Provider id") }, ["id"]),
        handler: ({ id }) => publicProvider(requireProvider(id), getSettings())
      },
      test: {
        description: "Send a real minimal completion to ONE provider, bypassing the fallback chain. Costs money.",
        schema: OBJECT({ id: STR("Provider id"), message: STR("Prompt to send") }, ["id"]),
        mutates: true,
        handler: async ({ id, message = "Reply with just: ok" }) => {
          const provider = requireProvider(id);
          const model = provider.models[0];
          if (!model) throw new Error(`Provider "${id}" lists no models`);
          try {
            const guard = guardRouted([{ role: "user", content: message }]);
            if (guard.blocked) throw new Error(blockedMessage(guard.findings.injection));
            const { response, attempts } = await routeChatCompletion({
              model: `${id}/${model}`,
              messages: guard.messages,
              max_tokens: 32
            });
            return {
              ok: true,
              content: response.choices?.[0]?.message?.content ?? "",
              usage: response.usage,
              usageSource: response.usage_source,
              attempts
            };
          } catch (err) {
            return { ok: false, error: err.message, attempts: publicAttempts(err.attempts) };
          }
        }
      },
      toggle: {
        description: "Enable or disable a provider for routing.",
        schema: OBJECT({ id: STR("Provider id"), enabled: BOOL("Target state") }, ["id", "enabled"]),
        mutates: true,
        handler: ({ id, enabled }) => {
          requireProvider(id);
          return { ok: true, disabledProviders: toggleProvider(id, Boolean(enabled)).disabledProviders };
        }
      }
    }
  },

  models: {
    description: "Model discovery and resolution.",
    tools: {
      list: {
        description: "Every model this gateway can route to, as provider/model ids.",
        schema: OBJECT({ available: BOOL("Only models on providers with a key") }),
        handler: ({ available }) =>
          providers
            .filter((p) => (available ? p.available : true))
            .flatMap((p) =>
              p.models.map((m) => ({
                id: `${p.id}/${m}`,
                provider: p.id,
                model: m,
                costPer1mTokens: priceFor(p, m),
                contextWindow: contextWindowFor(p, m),
                available: p.available
              }))
            )
      },
      resolve: {
        description: "Resolve a model string (auto, auto/<strategy>, combo/<name>, provider/model) to a routing chain.",
        schema: OBJECT({ model: STR("Model string to resolve") }, ["model"]),
        handler: ({ model }) => {
          const chain = buildCandidates(model, { messages: [{ role: "user", content: "resolve" }] });
          return {
            model,
            chainLength: chain.length,
            chain: chain.slice(0, 20).map((c) => ({
              provider: c.provider.id,
              model: c.model,
              tier: c.tier ?? 1,
              strategy: c.strategy ?? "explicit"
            }))
          };
        }
      },
      search: {
        description: "Find models whose id matches a substring.",
        schema: OBJECT({ query: STR("Substring to match") }, ["query"]),
        handler: ({ query }) => {
          const needle = String(query).toLowerCase();
          return providers.flatMap((p) =>
            p.models
              .filter((m) => m.toLowerCase().includes(needle) || p.id.includes(needle))
              .map((m) => ({ id: `${p.id}/${m}`, provider: p.id, available: p.available }))
          );
        }
      }
    }
  },

  routing: {
    description: "Routing strategies and chain preview.",
    tools: {
      strategies: {
        description: "Every available routing strategy with its description and route string.",
        schema: OBJECT(),
        handler: () => ({
          count: STRATEGY_IDS.length,
          strategies: STRATEGY_IDS.map((id) => ({
            id,
            label: STRATEGIES[id].label,
            description: STRATEGIES[id].description,
            route: `auto/${id}`
          })),
          aliases: STRATEGY_ALIASES
        })
      },
      preview: {
        description: "Show the exact fallback chain a model string would produce, without sending a request.",
        schema: OBJECT({
          model: STR("Model string, e.g. auto/cheapest or combo/free-first"),
          prompt: STR("Sample prompt, used for context-aware ordering")
        }),
        handler: ({ model = "auto", prompt = "preview" }) => {
          const settings = getSettings();
          const chain = buildCandidates(model, { messages: [{ role: "user", content: prompt }] });
          return {
            model,
            promptTokens: estimateTokens(prompt),
            chain: chain.map((c) => ({
              provider: c.provider.id,
              model: c.model,
              tier: c.tier ?? 1,
              strategy: c.strategy ?? "explicit",
              billing: billingOf(c.provider, settings.subscriptionProviders),
              hasKey: c.provider.available
            }))
          };
        }
      },
      order_by_strategy: {
        description: "Order the provider pool by one named strategy. Diagnostic: shows why a lane ranks where it does.",
        schema: OBJECT({ strategy: STR("Strategy id or alias"), prompt: STR("Sample prompt") }, ["strategy"]),
        handler: ({ strategy, prompt = "preview" }) => {
          const settings = getSettings();
          const pool = providers.filter((p) => p.models.length > 0 && !settings.disabledProviders.includes(p.id));
          const ctx = strategyContext({
            request: { messages: [{ role: "user", content: prompt }] },
            settings,
            pool
          });
          return {
            strategy,
            order: orderByStrategy(strategy, pool, ctx).map((p, i) => ({
              rank: i + 1,
              provider: p.id,
              billing: billingOf(p, settings.subscriptionProviders),
              blendedCostPer1m: (priceFor(p, p.models[0]).input || 0) + (priceFor(p, p.models[0]).output || 0) * 3,
              contextWindow: p.contextWindow ?? null
            }))
          };
        }
      }
    }
  },

  combos: {
    description: "Tiered routing combos: build, save and select multi-tier fallback chains.",
    tools: {
      list: {
        description: "Built-in and saved combos with their tier definitions.",
        schema: OBJECT(),
        handler: () => {
          const settings = getSettings();
          return {
            defaultCombo: settings.defaultCombo,
            maxTiers: MAX_TIERS,
            filterKeys: FILTER_KEYS,
            combos: Object.entries(listCombos(settings.combos)).map(([name, combo]) => ({
              name,
              label: combo.label || name,
              description: combo.description || "",
              custom: combo.custom === true,
              strict: combo.strict === true,
              tiers: combo.tiers,
              route: `combo/${name}`
            }))
          };
        }
      },
      get: {
        description: "One combo by name, with its full tier and filter definition.",
        schema: OBJECT({ name: STR("Combo name") }, ["name"]),
        handler: ({ name }) => {
          const combo = listCombos(getSettings().combos)[comboName(name)];
          if (!combo) throw new Error(`No combo named "${name}"`);
          return { name: comboName(name), ...combo };
        }
      },
      save: {
        description: "Create or replace a custom combo. Tiers are tried in order; each may filter the pool.",
        schema: OBJECT(
          {
            name: STR("Combo name (a-z, 0-9, -)"),
            tiers: {
              type: "array",
              description: `Up to ${MAX_TIERS} tiers, each { strategy, filter }`,
              items: OBJECT({ strategy: STR("Strategy id"), filter: OBJECT() }, ["strategy"])
            },
            label: STR("Display label"),
            description: STR("What this combo is for")
          },
          ["name", "tiers"]
        ),
        mutates: true,
        handler: ({ name, tiers, label, description }) => {
          const slug = comboName(name);
          if (!slug) throw new Error("combo name must contain a-z, 0-9 or -");
          const parsed = validateCombo({ tiers, label, description });
          if (!parsed.ok) throw new Error(parsed.error);
          updateSettings({ combos: { ...getSettings().combos, [slug]: parsed.value } });
          return { ok: true, name: slug, combo: parsed.value, route: `combo/${slug}` };
        }
      },
      delete: {
        description: "Delete a custom combo. Built-ins cannot be deleted.",
        schema: OBJECT({ name: STR("Combo name") }, ["name"]),
        mutates: true,
        handler: ({ name }) => {
          const slug = comboName(name);
          const settings = getSettings();
          if (!settings.combos[slug]) throw new Error(`No saved combo named "${slug}"`);
          const combos = { ...settings.combos };
          delete combos[slug];
          const patch = { combos };
          if (settings.defaultCombo === slug) patch.defaultCombo = null;
          updateSettings(patch);
          return { ok: true, deleted: slug };
        }
      },
      set_default: {
        description: 'Set the combo a bare "auto" uses. Pass null to go back to priority order.',
        schema: OBJECT({ name: STR("Combo name, or null") }),
        mutates: true,
        handler: ({ name }) => {
          if (name === null || name === undefined || name === "") {
            updateSettings({ defaultCombo: null });
            return { ok: true, defaultCombo: null };
          }
          const slug = comboName(name);
          if (!listCombos(getSettings().combos)[slug]) throw new Error(`No combo named "${slug}"`);
          updateSettings({ defaultCombo: slug });
          return { ok: true, defaultCombo: slug };
        }
      }
    }
  },

  completions: {
    description: "Send completions through the gateway, with full routing and cost tracking.",
    tools: {
      chat: {
        description: "Route a chat completion. Costs money. The whole fallback chain and every cap applies.",
        schema: OBJECT(
          {
            model: STR('Model string, default "auto"'),
            messages: {
              type: "array",
              description: "OpenAI-format messages",
              items: OBJECT({ role: STR("role"), content: STR("content") }, ["role", "content"])
            },
            max_tokens: NUM("Cap on generated tokens"),
            temperature: NUM("Sampling temperature")
          },
          ["messages"]
        ),
        mutates: true,
        handler: async ({ model = "auto", messages, max_tokens, temperature }) => {
          // Agent-supplied content is routed content. It gets the same PII
          // redaction and injection policy the HTTP dialects get.
          const guard = guardRouted(messages);
          if (guard.blocked) throw new Error(blockedMessage(guard.findings.injection));
          const { response, attempts } = await routeChatCompletion({ model, messages: guard.messages, max_tokens, temperature });
          return {
            content: response.choices?.[0]?.message?.content ?? "",
            provider: response.provider,
            model: response.model,
            usage: response.usage,
            usageSource: response.usage_source,
            attempts
          };
        }
      },
      estimate: {
        description: "Estimate what a request would cost on a given lane, before sending it.",
        schema: OBJECT(
          { model: STR("provider/model"), prompt: STR("The prompt text"), max_tokens: NUM("Expected output tokens") },
          ["model", "prompt"]
        ),
        handler: ({ model, prompt, max_tokens = 512 }) => {
          const [providerId, ...rest] = model.split("/");
          const provider = requireProvider(providerId);
          const modelName = rest.join("/") || provider.models[0];
          const price = priceFor(provider, modelName);
          const request = { messages: [{ role: "user", content: prompt }], max_tokens };
          return {
            provider: providerId,
            model: modelName,
            promptTokens: estimateTokens(promptTextOf(request)),
            maxOutputTokens: max_tokens,
            costPer1mTokens: price,
            estimatedCostUsd: Number(estimateRequestCost(request, price).toFixed(8)),
            pricingVerified: isPricingVerified(provider),
            note: "An estimate from local token counting and the configured price table, not a quote."
          };
        }
      }
    }
  },

  quota: {
    description: "Free-tier quota: pool-deduped counting of what has been drawn down.",
    tools: {
      snapshot: {
        description: "Every declared free tier plus the pool view, which is the honest one.",
        schema: OBJECT(),
        handler: () => quotaSnapshot()
      },
      status: {
        description: "One provider's free-tier state: limits, usage, remaining, headroom.",
        schema: OBJECT({ id: STR("Provider id") }, ["id"]),
        handler: ({ id }) => {
          requireProvider(id);
          const status = quotaStatus(id);
          if (!status) return { providerId: id, freeTier: false, note: "This provider declares no free tier." };
          return status;
        }
      },
      pools: {
        description: "Shared free-quota pools and which providers draw on each.",
        schema: OBJECT(),
        handler: () => {
          const snap = quotaSnapshot();
          return {
            pools: snap.pools,
            dedupedAway: snap.totals.dedupedAway,
            assumedPools: snap.totals.assumedPools,
            note: 'Pools marked "assumed" have not been confirmed to be a single upstream allowance.'
          };
        }
      },
      reset: {
        description: "Clear observed quota counters. Does not reset anything at the vendor.",
        schema: OBJECT(),
        mutates: true,
        handler: () => {
          resetQuota();
          return { ok: true, quota: quotaSnapshot() };
        }
      }
    }
  },

  budgets: {
    description: "Monthly spend caps, enforced at routing time.",
    tools: {
      list: {
        description: "Every cap against month-to-date spend.",
        schema: OBJECT(),
        handler: () => {
          const caps = getSettings().budgetCapsUsd;
          return providers
            .filter((p) => caps[p.id] !== undefined || getMonthlySpend(p.id) > 0)
            .map((p) => ({
              provider: p.id,
              capUsd: caps[p.id] ?? null,
              spentUsd: getMonthlySpend(p.id),
              remainingUsd: caps[p.id] !== undefined ? Math.max(0, caps[p.id] - getMonthlySpend(p.id)) : null,
              pricingVerified: isPricingVerified(p),
              enforceable: Boolean(p.costPer1mTokens?.input || p.costPer1mTokens?.output)
            }));
        }
      },
      set: {
        description: "Set a monthly cap. Warns when the price table behind it is unverified or zero.",
        schema: OBJECT({ id: STR("Provider id"), capUsd: NUM("Monthly cap in USD") }, ["id", "capUsd"]),
        mutates: true,
        handler: ({ id, capUsd }) => {
          const provider = requireProvider(id);
          const settings = setBudgetCap(id, capUsd);
          const zeroPriced = !provider.costPer1mTokens?.input && !provider.costPer1mTokens?.output;
          return {
            ok: true,
            capUsd: settings.budgetCapsUsd[id],
            warning: zeroPriced
              ? `Pricing for "${id}" is 0/0, so recorded spend is always $0 and this cap can never trip.`
              : isPricingVerified(provider)
                ? null
                : `Pricing for "${id}" is unverified, so this cap may fire early or not at all.`
          };
        }
      },
      clear: {
        description: "Remove a provider's cap.",
        schema: OBJECT({ id: STR("Provider id") }, ["id"]),
        mutates: true,
        handler: ({ id }) => {
          requireProvider(id);
          setBudgetCap(id, null);
          return { ok: true, capUsd: null };
        }
      },
      spend: {
        description: "Month-to-date spend for one provider or all.",
        schema: OBJECT({ id: STR("Provider id, omit for all") }),
        handler: ({ id }) =>
          id
            ? { provider: id, spentUsd: getMonthlySpend(id) }
            : Object.fromEntries(providers.map((p) => [p.id, getMonthlySpend(p.id)]))
      }
    }
  },

  cost: {
    description: "Spend accounting and reconciliation.",
    tools: {
      summary: {
        description: "Totals per provider, plus how much of the figure is provider-reported rather than estimated.",
        schema: OBJECT(),
        handler: () => getUsageSummary()
      },
      series: {
        description: "Time-bucketed spend, tokens and request counts.",
        schema: OBJECT({ bucket: ENUM(["hour", "day"], "Bucket size"), points: NUM("How many buckets") }),
        handler: ({ bucket = "hour", points = 24 }) =>
          getUsageSeries({ bucket, points: Math.min(Math.max(Number(points) || 24, 2), 90) })
      },
      ledger: {
        description: "One row per provider per month, for holding next to a vendor invoice.",
        schema: OBJECT({ month: STR("YYYY-MM, defaults to this month") }),
        handler: ({ month }) => {
          const ledger = getLedger(/^\d{4}-\d{2}$/.test(month || "") ? month : undefined);
          return {
            ...ledger,
            rows: ledger.rows.map((r) => {
              const provider = getProvider(r.providerId);
              return { ...r, trustworthy: provider ? isPricingVerified(provider) : false };
            })
          };
        }
      },
      confidence: {
        description: "What share of recorded spend rests on provider-reported token counts.",
        schema: OBJECT(),
        handler: () => getUsageSummary().confidence
      },
      reload: {
        description:
          "Re-read usage.jsonl from disk and rebuild the in-memory aggregates. For after the log is edited or rotated externally.",
        schema: OBJECT(),
        mutates: true,
        handler: async () => {
          const { reload } = await import("../storage/costTracker.js");
          reload();
          const usage = getUsageSummary();
          return { ok: true, requests: usage.totalRequests, costUsd: usage.totalCostUsd, corruptLines: usage.corruptLines };
        }
      }
    }
  },

  cache: {
    description: "Exact-match response cache.",
    tools: {
      stats: {
        description: "Hit rate, size and entry count. The cache is exact-match only, never semantic.",
        schema: OBJECT(),
        handler: () => ({
          ...cache.stats(),
          semantics: "exact match on deterministic requests only, partitioned per caller"
        })
      },
      clear: {
        description: "Drop every cached response.",
        schema: OBJECT(),
        mutates: true,
        handler: () => {
          cache.clear();
          return { ok: true, cache: cache.stats() };
        }
      }
    }
  },

  resilience: {
    description: "The 3-layer failure state: provider breakers, cooling keys, locked models.",
    tools: {
      snapshot: {
        description: "Current breaker, connection and model lockout state.",
        schema: OBJECT(),
        handler: () => resilience.snapshot()
      },
      reset: {
        description: "Clear all breakers, cooldowns and lockouts.",
        schema: OBJECT(),
        mutates: true,
        handler: () => {
          resilience.reset();
          return { ok: true, resilience: resilience.snapshot() };
        }
      }
    }
  },

  compression: {
    description: "RTK structural and Caveman lossy compression on context and tool output.",
    tools: {
      config: {
        description: "Current compression configuration, all three layers.",
        schema: OBJECT(),
        handler: () => ({
          ...getSettings().compression,
          levels: CAVEMAN_LEVELS,
          scopes: CAVEMAN_SCOPES,
          layers: {
            base: "whitespace + consecutive duplicate lines, always on",
            rtk: "tabularize uniform JSON, collapse runs, elide blobs",
            caveman: "lossy prose compression; never applied to a system prompt"
          }
        })
      },
      set: {
        description: "Change compression settings. Nested rtk/caveman groups merge rather than replace.",
        schema: OBJECT({
          enabled: BOOL("Master switch"),
          historyWindow: NUM("How many non-system messages to keep"),
          rtk: OBJECT({
            enabled: BOOL(""),
            tabularize: BOOL(""),
            runs: BOOL(""),
            blobs: BOOL(""),
            dictionary: BOOL("")
          }),
          caveman: OBJECT({
            enabled: BOOL(""),
            level: ENUM(CAVEMAN_LEVELS, "How aggressive"),
            scope: ENUM(CAVEMAN_SCOPES, "Which messages it applies to")
          })
        }),
        mutates: true,
        handler: (args) => {
          const parsed = validateCompression(args);
          if (!parsed.ok) throw new Error(parsed.error);
          const current = getSettings().compression;
          updateSettings({
            compression: {
              ...current,
              ...parsed.value,
              rtk: { ...current.rtk, ...(parsed.value.rtk || {}) },
              caveman: { ...current.caveman, ...(parsed.value.caveman || {}) }
            }
          });
          return { ok: true, compression: getSettings().compression };
        }
      },
      preview: {
        description: "Compress messages and report per-layer savings, without sending anything upstream.",
        schema: OBJECT(
          {
            messages: {
              type: "array",
              description: "Messages to compress",
              items: OBJECT({ role: STR(""), content: STR("") }, ["role", "content"])
            }
          },
          ["messages"]
        ),
        handler: ({ messages }) => {
          const result = compressMessagesWithStats(messages, getSettings().compression);
          return { stats: result.stats, messages: result.messages };
        }
      }
    }
  },

  memory: {
    description: "Persistent conversational memory with hybrid keyword + vector recall.",
    tools: {
      status: {
        description: "Backend in use, store size, and the EFFECTIVE recall mode versus the configured one.",
        schema: OBJECT(),
        handler: () => memory.memoryStatus()
      },
      remember: {
        description: "Store a memory in a session.",
        schema: OBJECT(
          { text: STR("What to remember"), sessionId: STR("Session partition"), role: STR("user or assistant") },
          ["text"]
        ),
        mutates: true,
        handler: ({ text, sessionId = "mcp", role = "user" }) => {
          const stored = memory.remember({ sessionId, role, text });
          if (!stored) throw new Error("text must be a non-empty string");
          return stored;
        }
      },
      recall: {
        description: "Hybrid recall. Reports which halves ran and why any was skipped.",
        schema: OBJECT(
          {
            query: STR("What to search for"),
            sessionId: STR("Session partition"),
            mode: ENUM(memory.RECALL_MODES, "keyword, vector or hybrid"),
            limit: NUM("Max results"),
            crossSession: BOOL("Search every session, not just this one")
          },
          ["query"]
        ),
        handler: ({ query, sessionId = "mcp", mode, limit = 6, crossSession = false }) =>
          memory.recall(query, {
            sessionId,
            mode: mode || getSettings().memory.recall,
            limit: Math.min(Math.max(Number(limit) || 6, 1), 50),
            crossSession: crossSession === true
          })
      },
      forget: {
        description: "Delete one memory, a whole session, or everything. Destructive.",
        schema: OBJECT({ sessionId: STR("Session to clear"), id: NUM("Single memory id"), all: BOOL("Clear everything") }),
        mutates: true,
        handler: ({ sessionId, id, all }) => {
          if (id !== undefined) return { ok: true, deleted: memory.forget({ id: Number(id) }) };
          if (all === true) return { ok: true, deleted: memory.forget({}), scope: "all" };
          if (!sessionId) throw new Error("pass sessionId, id, or all: true");
          return { ok: true, deleted: memory.forget({ sessionId }), scope: "session" };
        }
      },
      sync_vectors: {
        description: "Embed memories that have no vector yet and upsert them to Qdrant.",
        schema: OBJECT({ batchSize: NUM("How many to embed") }),
        mutates: true,
        handler: ({ batchSize = 64 }) => memory.syncVectors({ batchSize: Math.min(Number(batchSize) || 64, 512) })
      }
    }
  },

  notion: {
    description: "Notion workspace as read-only context.",
    tools: {
      status: {
        description: "Whether Notion is configured and reachable.",
        schema: OBJECT(),
        handler: () => notion.notionStatus()
      },
      search: {
        description: "Search pages and databases shared with the integration.",
        schema: OBJECT({ query: STR("Search text"), limit: NUM("Max results") }, ["query"]),
        handler: ({ query, limit = 10 }) => notion.search(query, { limit })
      },
      read_page: {
        description: "Read a page's top-level block text.",
        schema: OBJECT({ pageId: STR("Notion page id") }, ["pageId"]),
        handler: ({ pageId }) => notion.readPage(pageId)
      }
    }
  },

  obsidian: {
    description: "Local Obsidian vault as read-only context.",
    tools: {
      status: {
        description: "Vault path, note count and the containment rule in force.",
        schema: OBJECT(),
        handler: () => obsidian.obsidianStatus()
      },
      list: {
        description: "List notes, newest first.",
        schema: OBJECT({ limit: NUM("Max notes") }),
        handler: ({ limit = 200 }) => obsidian.listNotes({ limit: Math.min(Number(limit) || 200, 2000) })
      },
      read: {
        description: "Read one note. Paths resolving outside the vault are refused.",
        schema: OBJECT({ path: STR("Vault-relative path") }, ["path"]),
        handler: ({ path: notePath }) => obsidian.readNote(notePath)
      },
      search: {
        description: "Search note text and filenames.",
        schema: OBJECT({ query: STR("Search text"), limit: NUM("Max results") }, ["query"]),
        handler: ({ query, limit = 10 }) => obsidian.searchNotes(query, { limit })
      }
    }
  },

  guards: {
    description: "Prompt-injection scanning, PII redaction and content-filter normalization.",
    tools: {
      status: {
        description: "Current guardrail configuration, with an honest statement of what it is.",
        schema: OBJECT(),
        handler: () => {
          const settings = getSettings();
          return {
            redactPii: settings.redactPii === true,
            injectionMode: settings.injectionMode || "off",
            scannedRoles: ["user", "tool"],
            honesty:
              "Heuristics, not boundaries. PII redaction is pattern matching, not DLP. " +
              "Injection detection is a known-unsolved problem, so treat a clean scan as weak evidence."
          };
        }
      },
      set: {
        description: "Configure PII redaction and injection mode.",
        schema: OBJECT({
          redactPii: BOOL("Redact detected PII before sending upstream"),
          injectionMode: ENUM(["off", "flag", "block"], "What to do on a detection")
        }),
        mutates: true,
        handler: ({ redactPii: redact, injectionMode }) => {
          const patch = {};
          if (redact !== undefined) patch.redactPii = Boolean(redact);
          if (injectionMode !== undefined) {
            if (!["off", "flag", "block"].includes(injectionMode)) {
              throw new Error("injectionMode must be off, flag or block");
            }
            patch.injectionMode = injectionMode;
          }
          const settings = updateSettings(patch);
          return { ok: true, redactPii: settings.redactPii === true, injectionMode: settings.injectionMode || "off" };
        }
      },
      scan: {
        description: "Scan text for injection patterns and PII without sending it anywhere.",
        schema: OBJECT({ text: STR("Text to scan") }, ["text"]),
        handler: ({ text }) => {
          const redacted = redactPii(String(text));
          return {
            injection: detectInjection(String(text)),
            pii: redacted.found,
            redactedPreview: redacted.text.slice(0, 2000)
          };
        }
      },
      check_messages: {
        description: "Run the full guardrail pass over a message array, exactly as a real request would.",
        schema: OBJECT(
          { messages: { type: "array", items: OBJECT({ role: STR(""), content: STR("") }, ["role", "content"]) } },
          ["messages"]
        ),
        handler: ({ messages }) => {
          const settings = getSettings();
          const result = applyGuardrails(messages, {
            redactPii: settings.redactPii === true,
            injectionMode: settings.injectionMode || "off"
          });
          return { blocked: result.blocked, findings: result.findings };
        }
      }
    }
  },

  proxy: {
    description: "Egress proxy across three resolution levels. No TLS interception, ever.",
    tools: {
      status: {
        description: "Configured proxies at every level, plus the active TLS profile.",
        schema: OBJECT(),
        handler: () => proxyStatus()
      },
      plan: {
        description: "What every provider will actually do, and which level decided it.",
        schema: OBJECT(),
        handler: () => ({ plan: proxyPlan(providers), levels: ["provider", "category", "global", "env"] })
      },
      resolve: {
        description: "Which proxy one provider resolves to, and at which level.",
        schema: OBJECT({ id: STR("Provider id") }, ["id"]),
        handler: ({ id }) => {
          requireProvider(id);
          return { provider: id, ...resolveProxy(id) };
        }
      },
      set: {
        description: "Set a proxy for a provider, a category, or globally. Pass null to clear.",
        schema: OBJECT({
          url: STR("Proxy URL, or null to clear"),
          providerId: STR('Provider id, or "*" for global'),
          category: ENUM(["frontier", "inference", "aggregator", "local"], "Set at category level instead")
        }),
        mutates: true,
        handler: ({ url, providerId = "*", category }) => {
          const parsed = validateProxyUrl(url);
          if (!parsed.ok) throw new Error(parsed.error);
          const settings = getSettings();

          if (category) {
            const categories = { ...settings.proxyCategories };
            if (parsed.value === null) delete categories[category];
            else categories[category] = parsed.value;
            updateSettings({ proxyCategories: categories });
          } else {
            if (providerId !== "*") requireProvider(providerId);
            const proxies = { ...settings.proxies };
            if (parsed.value === null) delete proxies[providerId];
            else proxies[providerId] = parsed.value;
            updateSettings({ proxies });
          }
          clearAgentCache(); // a cached agent would keep using the old proxy
          return { ok: true, proxy: proxyStatus() };
        }
      }
    }
  },

  tls: {
    description: "Outbound TLS handshake shaping. Not browser impersonation. Read the caveat.",
    tools: {
      profiles: {
        description: "Available TLS profiles and what each actually changes.",
        schema: OBJECT(),
        handler: () => tlsStatus(getSettings().tlsProfile)
      },
      get: {
        description: "The active TLS profile.",
        schema: OBJECT(),
        handler: () => {
          const status = tlsStatus(getSettings().tlsProfile);
          return { active: status.active, label: status.label, caveat: status.caveat };
        }
      },
      set: {
        description: "Change the outbound TLS profile. Applies to every upstream request.",
        schema: OBJECT({ profile: ENUM(TLS_PROFILE_IDS, "Profile id") }, ["profile"]),
        mutates: true,
        handler: ({ profile }) => {
          const parsed = validateTlsProfile(profile);
          if (!parsed.ok) throw new Error(parsed.error);
          updateSettings({ tlsProfile: parsed.value });
          clearAgentCache(); // dispatchers are cached per profile
          return { ok: true, ...tlsStatus(parsed.value) };
        }
      }
    }
  },

  auth: {
    description: "Gateway authentication and rate limiting. Never returns the key itself.",
    tools: {
      status: {
        description: "Whether auth is on, whether the key is encrypted at rest, and the rate limit.",
        schema: OBJECT(),
        handler: () => ({
          gatewayAuthEnabled: Boolean(getSettings().gatewayApiKey),
          keyEncryptedAtRest: isKeyEncryptedAtRest(),
          encryptionAvailable: isEncryptionAvailable(),
          rateLimit: rateLimiter.getConfig()
        })
      },
      generate_key: {
        description: "Generate a strong candidate key. Does NOT install it. Setting the gateway key is panel-only.",
        schema: OBJECT(),
        handler: () => ({
          apiKey: generateApiKey(),
          note:
            "Returned for you to set from the control panel. This tool cannot install it: an agent able to " +
            "set the gateway key could lock the operator out, and one able to clear it could disable auth."
        })
      },
      set_rate_limit: {
        description: "Configure the /v1 token bucket.",
        schema: OBJECT({ enabled: BOOL(""), capacity: NUM("Bucket size"), refillPerMinute: NUM("Refill rate") }),
        mutates: true,
        handler: (args) => {
          rateLimiter.configure(args);
          return { ok: true, rateLimit: rateLimiter.getConfig() };
        }
      }
    }
  },

  services: {
    description: "Managed sidecars: Bifrost, 9Router, CLIProxy. Supervises only, never installs.",
    tools: {
      list: {
        description: "Declared services, whether each is running, and cluster profiles.",
        schema: OBJECT(),
        handler: () => services.servicesStatus(getSettings())
      },
      start: {
        description: "Start a declared service. The binary must already be on PATH.",
        schema: OBJECT({ id: ENUM(services.SERVICE_IDS, "Service id"), port: NUM("Port to bind") }, ["id"]),
        mutates: true,
        handler: ({ id, port }) => {
          const result = services.startService(id, { port, binary: getSettings().serviceBinaries?.[id] });
          if (!result.ok) throw new Error(result.error);
          return result;
        }
      },
      stop: {
        description: "Stop a running service.",
        schema: OBJECT({ id: ENUM(services.SERVICE_IDS, "Service id"), signal: ENUM(["SIGTERM", "SIGINT", "SIGKILL"], "") }, ["id"]),
        mutates: true,
        handler: ({ id, signal = "SIGTERM" }) => {
          const result = services.stopService(id, { signal });
          if (!result.ok) throw new Error(result.error);
          return result;
        }
      },
      logs: {
        description: "Recent stdout/stderr from a service started this session.",
        schema: OBJECT({ id: ENUM(services.SERVICE_IDS, "Service id"), lines: NUM("How many lines") }, ["id"]),
        handler: ({ id, lines = 100 }) => {
          const result = services.serviceLogs(id, { lines });
          if (!result.ok) throw new Error(result.error);
          return result;
        }
      },
      health: {
        description: "Probe a running service's health endpoint.",
        schema: OBJECT({ id: ENUM(services.SERVICE_IDS, "Service id") }, ["id"]),
        handler: ({ id }) => services.serviceHealth(id)
      },
      start_profile: {
        description: "Start a named cluster profile. Partial success is reported as partial.",
        schema: OBJECT({ profile: STR("Profile id") }, ["profile"]),
        mutates: true,
        handler: ({ profile }) => services.startProfile(profile)
      }
    }
  },

  cloud_agents: {
    description: "Codex, Cursor, Devin and Jules through one interface. Every driver is unverified.",
    tools: {
      list: {
        description: "Available drivers, which have a key, and which capabilities each really has.",
        schema: OBJECT(),
        handler: () => cloud.cloudAgentStatus()
      },
      create_task: {
        description: "Create a task on a cloud agent. Costs money at the vendor.",
        schema: OBJECT(
          {
            driver: ENUM(cloud.DRIVER_IDS, "Which agent"),
            prompt: STR("What to do"),
            repo: STR("Repository, vendor-specific format"),
            model: STR("Model override")
          },
          ["driver", "prompt"]
        ),
        mutates: true,
        handler: ({ driver, prompt, repo, model }) => cloud.createTask(driver, { prompt, repo, model })
      },
      get_task: {
        description: "Fetch a task's status and output.",
        schema: OBJECT({ driver: ENUM(cloud.DRIVER_IDS, ""), id: STR("Task id") }, ["driver", "id"]),
        handler: ({ driver, id }) => cloud.getTask(driver, id)
      },
      list_tasks: {
        description: "List tasks. Unsupported on drivers with no task-list API.",
        schema: OBJECT({ driver: ENUM(cloud.DRIVER_IDS, "") }, ["driver"]),
        handler: ({ driver }) => cloud.listTasks(driver)
      },
      approve_plan: {
        description: "Approve a proposed plan. Only Devin and Jules really support this.",
        schema: OBJECT({ driver: ENUM(cloud.DRIVER_IDS, ""), id: STR("Task id"), message: STR("Approval note") }, [
          "driver",
          "id"
        ]),
        mutates: true,
        handler: ({ driver, id, message }) => cloud.approvePlan(driver, id, message)
      },
      cancel_task: {
        description: "Cancel a running task where the vendor allows it.",
        schema: OBJECT({ driver: ENUM(cloud.DRIVER_IDS, ""), id: STR("Task id") }, ["driver", "id"]),
        mutates: true,
        handler: ({ driver, id }) => cloud.cancelTask(driver, id)
      }
    }
  },

  gamification: {
    description: "Streaks, achievements and live savings against a stated baseline.",
    tools: {
      status: {
        description: "Streak, savings and achievement progress in one call.",
        schema: OBJECT(),
        handler: async () =>
          gamificationSnapshot({
            settings: getSettings(),
            memoryTotal: (await memory.memoryStatus()).store.total
          })
      },
      achievements: {
        description: "Achievement list with progress toward each target.",
        schema: OBJECT(),
        handler: async () =>
          achievements({
            usage: getUsageSummary(),
            quota: quotaSnapshot(),
            streak: streak(),
            settings: getSettings(),
            memoryTotal: (await memory.memoryStatus()).store.total
          })
      },
      streak: {
        description: "Consecutive days of use, and the longest run in the window.",
        schema: OBJECT(),
        handler: () => streak()
      },
      savings: {
        description: "Savings as a counterfactual against an explicitly stated baseline lane.",
        schema: OBJECT(),
        handler: () => savings()
      }
    }
  },

  a2a: {
    description: "Agent-to-Agent protocol surface exposed by this gateway.",
    tools: {
      agent_card: {
        description: "The A2A Agent Card describing this gateway's skills.",
        schema: OBJECT(),
        handler: async () => (await import("../a2a/card.js")).agentCard()
      },
      skills: {
        description: "A2A skills this gateway offers, with their input shapes.",
        schema: OBJECT(),
        handler: async () => {
          const { SKILLS } = await import("../a2a/skills.js");
          return Object.entries(SKILLS).map(([id, skill]) => ({
            id,
            name: skill.name,
            description: skill.description,
            inputSchema: skill.inputSchema
          }));
        }
      }
    }
  },

  mcp: {
    description: "This MCP server describing itself.",
    tools: {
      scopes: {
        description: "Every scope with its tool count.",
        schema: OBJECT(),
        handler: () =>
          Object.entries(SCOPES).map(([name, scope]) => ({
            scope: name,
            description: scope.description,
            tools: Object.keys(scope.tools).length
          }))
      },
      tools: {
        description: "Every tool, optionally filtered to one scope.",
        schema: OBJECT({ scope: STR("Scope name"), mutatingOnly: BOOL("Only tools that change state") }),
        handler: ({ scope, mutatingOnly }) =>
          listTools()
            .filter((t) => (scope ? t.scope === scope : true))
            .filter((t) => (mutatingOnly ? t.mutates : true))
            .map((t) => ({ name: t.name, scope: t.scope, description: t.description, mutates: t.mutates }))
      },
      describe_tool: {
        description: "One tool's full input schema.",
        schema: OBJECT({ name: STR("Tool name") }, ["name"]),
        handler: ({ name }) => {
          const tool = listTools().find((t) => t.name === name);
          if (!tool) throw new Error(`Unknown tool "${name}"`);
          return { name: tool.name, scope: tool.scope, description: tool.description, mutates: tool.mutates, inputSchema: tool.inputSchema };
        }
      }
    }
  },

  settings: {
    description: "Gateway settings. The gateway key is never readable or writable here.",
    tools: {
      get: {
        description: "All settings, with the gateway key reduced to a presence flag.",
        schema: OBJECT(),
        handler: () => redactedSettings()
      },
      patch: {
        description: "Update settings. Only an allowlisted set of keys is writable.",
        schema: OBJECT({ patch: OBJECT({}, []) }, ["patch"]),
        mutates: true,
        handler: ({ patch }) => {
          if (!patch || typeof patch !== "object") throw new Error("patch must be an object");
          const rejected = Object.keys(patch).filter((k) => !PATCHABLE_SETTINGS.has(k));
          if (rejected.length) {
            throw new Error(
              `These settings cannot be written through MCP: ${rejected.join(", ")}. ` +
                `Writable: ${[...PATCHABLE_SETTINGS].join(", ")}`
            );
          }
          updateSettings(patch);
          return { ok: true, settings: redactedSettings() };
        }
      }
    }
  },

  usage: {
    description: "Recent request history.",
    tools: {
      recent: {
        description: "The most recent requests with provider, cost and latency.",
        schema: OBJECT({ limit: NUM("How many") }),
        handler: ({ limit = 20 }) => getUsageSummary().recent.slice(0, Math.min(Number(limit) || 20, 100))
      },
      by_provider: {
        description: "Per-provider request counts, tokens, cost and average latency.",
        schema: OBJECT(),
        handler: () => getUsageSummary().byProvider
      }
    }
  },

  pricing: {
    description: "The price table and how much of it is actually trustworthy.",
    tools: {
      table: {
        description: "Per-provider and per-model rates, in USD per million tokens.",
        schema: OBJECT(),
        handler: () =>
          providers.map((p) => ({
            provider: p.id,
            costPer1mTokens: p.costPer1mTokens,
            modelPricing: p.modelPricing || null,
            pricingVerified: p.pricingVerified ?? false
          }))
      },
      trust: {
        description: "How many lanes have verified pricing, and which have unenforceable zero rates.",
        schema: OBJECT(),
        handler: () => {
          const remote = providers.filter((p) => p.category !== "local");
          const unenforceable = remote.filter((p) => !p.costPer1mTokens?.input && !p.costPer1mTokens?.output);
          return {
            total: remote.length,
            verified: remote.filter(isPricingVerified).length,
            unverified: remote.filter((p) => !isPricingVerified(p)).length,
            unenforceable: unenforceable.map((p) => p.id),
            note: "A 0/0 rate means recorded spend is always $0, so a budget cap on that lane can never trip."
          };
        }
      },
      unverified: {
        description: "Lanes with a key configured but unverified pricing: the ones that can cost real money.",
        schema: OBJECT(),
        handler: () =>
          providers.filter((p) => p.available && p.category !== "local" && !isPricingVerified(p)).map((p) => p.id)
      }
    }
  },

  context: {
    description: "Context window declarations and fit checks.",
    tools: {
      windows: {
        description: "Declared context window per provider. null means undeclared, not unlimited.",
        schema: OBJECT(),
        handler: () =>
          providers.map((p) => ({
            provider: p.id,
            contextWindow: p.contextWindow ?? null,
            verified: p.contextVerified === true
          }))
      },
      fit: {
        description: "Which lanes can hold a prompt of a given size.",
        schema: OBJECT({ prompt: STR("The prompt"), tokens: NUM("Or a token count directly") }),
        handler: ({ prompt, tokens }) => {
          const needed = Number(tokens) || estimateTokens(String(prompt || ""));
          const classified = providers.map((p) => {
            const window = contextWindowFor(p, p.models[0]);
            return {
              provider: p.id,
              contextWindow: window,
              fits: window === null ? null : window >= needed
            };
          });
          return {
            promptTokens: needed,
            fits: classified.filter((c) => c.fits === true).map((c) => c.provider),
            tooSmall: classified.filter((c) => c.fits === false).map((c) => c.provider),
            unknown: classified.filter((c) => c.fits === null).map((c) => c.provider)
          };
        }
      }
    }
  },

  sessions: {
    description: "Memory sessions.",
    tools: {
      list: {
        description: "How many memories exist and across how many sessions.",
        schema: OBJECT(),
        handler: () => memory.storeStats()
      },
      search: {
        description: "Keyword search across every session. Ignores session partitioning, so use it deliberately.",
        schema: OBJECT({ query: STR("Search text"), limit: NUM("Max results") }, ["query"]),
        handler: ({ query, limit = 10 }) =>
          memory.keywordSearch(query, { limit: Math.min(Number(limit) || 10, 50), crossSession: true })
      }
    }
  },

  diagnostics: {
    description: "Runtime facts useful when something is behaving unexpectedly.",
    tools: {
      environment: {
        description: "Which capability-affecting env vars are set. Values are never returned.",
        schema: OBJECT(),
        handler: () => {
          const flags = [
            "BIND_HOST", "PORT", "ALLOW_PATH_TOKEN", "ALLOW_UNLISTED_MODELS", "TOLLPIKE_SECRET",
            "TOLLPIKE_DATA_DIR", "TOLLPIKE_MEMORY_BACKEND", "QDRANT_URL", "QDRANT_API_KEY",
            "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "OBSIDIAN_VAULT", "NOTION_API_KEY",
            "UPSTREAM_TIMEOUT_MS", "UPSTREAM_STALL_TIMEOUT_MS"
          ];
          // Presence only. An env var's value is frequently a credential, and
          // this response lands in an agent transcript.
          return Object.fromEntries(flags.map((f) => [f, process.env[f] ? "<set>" : null]));
        }
      },
      paths: {
        description: "Where state is stored on disk.",
        schema: OBJECT(),
        handler: () => ({ dataDir, usageLog: `${dataDir}/usage.jsonl`, settings: `${dataDir}/settings.json`, quota: `${dataDir}/quota.json`, memory: `${dataDir}/memory.db` })
      },
      subsystems: {
        description: "One-line health for every optional subsystem, and why each is off if it is.",
        schema: OBJECT(),
        handler: async () => {
          const memoryStatus = await memory.memoryStatus();
          return {
            memory: { enabled: memoryStatus.enabled, backend: memoryStatus.store.backend, effectiveMode: memoryStatus.effectiveMode },
            vector: { reachable: memoryStatus.vector.reachable, reason: memoryStatus.vector.reason },
            notion: { configured: notion.notionConfigured() },
            obsidian: { configured: obsidian.obsidianConfigured() },
            quota: { declaredFreeProviders: quotaSnapshot().totals.declaredFreeProviders },
            services: { running: services.servicesStatus(getSettings()).services.filter((s) => s.running).map((s) => s.id) },
            cloudAgents: { withKeys: cloud.cloudAgentStatus().drivers.filter((d) => d.hasKey).map((d) => d.id) },
            proxy: { configured: Object.keys(getSettings().proxies || {}).length > 0 },
            tls: { profile: getSettings().tlsProfile }
          };
        }
      }
    }
  },

  dialects: {
    description: "The inbound wire formats this gateway understands.",
    tools: {
      list: {
        description: "Every inbound dialect and which clients it unlocks.",
        schema: OBJECT(),
        handler: () => [
          { endpoint: "POST /v1/chat/completions", format: "OpenAI chat", unlocks: ["Cursor", "Continue", "Aider", "any OpenAI SDK"] },
          { endpoint: "POST /v1/messages", format: "Anthropic messages", unlocks: ["Claude Code", "Cline", "Anthropic SDK"] },
          { endpoint: "POST /v1/responses", format: "OpenAI Responses", unlocks: ["Codex"] },
          { endpoint: "POST /api/chat", format: "Ollama", unlocks: ["anything with a hardcoded local-Ollama mode"] },
          { endpoint: "/vscode/<key>/...", format: "path-token alias", unlocks: ["clients that cannot send auth headers"], enabled: process.env.ALLOW_PATH_TOKEN === "true" }
        ]
      },
      capabilities: {
        description: "What each dialect does NOT support, so a client is not surprised.",
        schema: OBJECT(),
        handler: () => ({
          "/v1/responses": "text and function tools only: no built-in tools, no previous_response_id threading, no reasoning items or images",
          "/v1/messages": "full text and tool streaming; block-structured stream is re-encoded from the internal delta shape",
          "/api/chat": "newline-delimited JSON, and stream defaults to TRUE unlike OpenAI",
          streaming: "fallback works only up to connection-open; once bytes flow the provider is committed"
        })
      }
    }
  }
};

// Flat tool list. `name` is what MCP sees, `scope` is retained for grouping.
export function listTools() {
  const out = [];
  for (const [scopeName, scope] of Object.entries(SCOPES)) {
    for (const [toolName, tool] of Object.entries(scope.tools)) {
      out.push({
        name: `${scopeName}_${toolName}`,
        scope: scopeName,
        description: tool.description,
        inputSchema: tool.schema,
        mutates: tool.mutates === true,
        handler: tool.handler
      });
    }
  }
  return out;
}

export function findTool(name) {
  return listTools().find((t) => t.name === name) || null;
}

export const TOOL_COUNT = listTools().length;
export const SCOPE_COUNT = Object.keys(SCOPES).length;

/**
 * Invoke a tool by name.
 *
 * `readOnly` refuses mutating tools rather than silently ignoring the flag —
 * that is what makes a read-only HTTP transport a real guarantee instead of a
 * label.
 */
export async function callTool(name, args = {}, { readOnly = false } = {}) {
  const tool = findTool(name);
  if (!tool) throw new Error(`Unknown tool "${name}". Call mcp_tools to list them.`);
  if (readOnly && tool.mutates) {
    throw new Error(`"${name}" changes gateway state and this transport is read-only.`);
  }
  return tool.handler(args || {});
}
