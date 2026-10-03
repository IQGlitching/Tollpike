// The hosts an egress rule must block for everyone except the gateway.
//
// Derived from the provider registry rather than written down, so adding a
// provider to config/providers.json adds it to the blocklist too. A firewall
// list maintained by hand is a list that is missing the newest provider.

import { providers } from "../providers/registry.js";

const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

export function providerHosts() {
  const hosts = new Map();
  for (const p of providers) {
    let host;
    try {
      host = new URL(p.baseURL).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (!host || LOCAL.has(host) || host.endsWith(".localhost")) continue;
    if (!hosts.has(host)) hosts.set(host, []);
    hosts.get(host).push(p.id);
  }
  return [...hosts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([host, ids]) => ({ host, providers: ids }));
}
