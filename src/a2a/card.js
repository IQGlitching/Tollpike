// A2A Agent Card.
//
// The discovery document a peer agent fetches before talking to this one,
// served at /.well-known/agent-card.json. It states identity, transport,
// capabilities and skills.
//
// Two things it deliberately gets right rather than copying from an example:
//
//   The URL reflects the ACTUAL bind address. A card advertising
//   http://localhost:20128 from a container bound to 0.0.0.0 sends every peer
//   to their own loopback, and the failure looks like the agent is down.
//
//   `authentication` reflects whether a gateway key is really set. Advertising
//   no auth scheme while requiring a bearer token means every peer's first call
//   401s with nothing in the card to explain why.

import { SKILLS, SKILL_IDS } from "./skills.js";
import { getSettings } from "../storage/settings.js";
import { providers } from "../providers/registry.js";

export const A2A_VERSION = "0.2.0";

function baseUrl() {
  const host = process.env.BIND_HOST || "127.0.0.1";
  const port = process.env.PORT || 20128;
  // A wildcard bind is not an address a peer can dial. Advertise loopback and
  // let a deployment override with PUBLIC_URL, rather than publishing 0.0.0.0.
  const dialable = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return process.env.PUBLIC_URL?.replace(/\/$/, "") || `http://${dialable}:${port}`;
}

export function agentCard() {
  const settings = getSettings();
  const authEnabled = Boolean(settings.gatewayApiKey);

  return {
    protocolVersion: A2A_VERSION,
    name: "Tollpike",
    description:
      "Self-hosted AI gateway. One endpoint over 36 providers with tiered fallback, hard spend caps, " +
      "free-quota accounting, compression and persistent memory. Optimised for cost control rather than provider reach.",
    url: `${baseUrl()}/a2a`,
    preferredTransport: "JSONRPC",
    version: "0.1.0",
    provider: { organization: "self-hosted", url: baseUrl() },
    documentationUrl: `${baseUrl()}/panel`,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: true
    },
    // Bearer, and only when a key is genuinely configured. Saying "none" while
    // enforcing a key is the single most confusing thing a card can do.
    securitySchemes: authEnabled
      ? { bearer: { type: "http", scheme: "bearer", description: "Gateway API key" } }
      : {},
    security: authEnabled ? [{ bearer: [] }] : [],
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: SKILL_IDS.map((id) => ({
      id,
      name: SKILLS[id].name,
      description: SKILLS[id].description,
      tags: SKILLS[id].tags,
      examples: SKILLS[id].examples,
      inputModes: ["text/plain", "application/json"],
      outputModes: ["text/plain", "application/json"]
    })),
    // Non-standard, and useful enough to justify itself: a peer deciding whether
    // to send work here wants to know how many lanes actually have credentials,
    // not just that the agent is reachable.
    tollpike: {
      providersConfigured: providers.length,
      providersAvailable: providers.filter((p) => p.available).length,
      skills: SKILL_IDS.length,
      authRequired: authEnabled
    }
  };
}
