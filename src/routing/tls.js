// Outbound TLS shaping.
//
// READ THIS BEFORE BELIEVING ANYTHING ABOUT WHAT IT DOES.
//
// This changes the TLS handshake THIS process sends: cipher suite list and
// order, signature algorithms, curve preference, TLS version floor, and ALPN
// protocol order. Those are the inputs to a JA3-style fingerprint, so a
// non-default profile does produce a different fingerprint from stock Node.
//
// It is NOT browser impersonation, and it will not reliably pass a real
// fingerprint allowlist. Genuine Chrome mimicry needs GREASE values, exact TLS
// extension ordering, and extension-level padding — none of which Node exposes
// through the `tls` module, because they are OpenSSL internals. Tools that do
// this properly (curl-impersonate, utls) ship a patched TLS stack. Calling the
// profiles below "chrome" would be claiming a capability that is not here, so
// they are named `*-like` and this comment exists.
//
// It also does NOT intercept, decrypt or re-sign anything. routing/proxy.js
// promises never to touch TLS in that sense and that promise is intact: this
// shapes the gateway's OWN client hello on connections it makes itself. No
// MITM, no CA, no certificate substitution.
//
// What it is genuinely useful for: some providers and some corporate middleboxes
// behave differently for a client whose handshake looks like a browser, and a
// gateway that cannot vary its handshake has no way to work around that.

const TLS13_SUITES = [
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256"
].join(":");

// Cipher strings are OpenSSL syntax. These approximate the ordering the named
// browser presents; they are not byte-identical to it.
export const TLS_PROFILES = {
  default: {
    label: "Default (Node)",
    description: "Node's stock TLS settings. The provider sees exactly what it is talking to.",
    connect: null
  },
  modern: {
    label: "Modern",
    description: "TLS 1.3 only, AEAD suites. Fails rather than negotiating down.",
    connect: {
      minVersion: "TLSv1.3",
      ciphers: TLS13_SUITES,
      ALPNProtocols: ["h2", "http/1.1"]
    }
  },
  "chrome-like": {
    label: "Chrome-like",
    description:
      "Cipher and curve ordering approximating Chrome, ALPN h2 first. Not true impersonation — no GREASE or extension ordering.",
    connect: {
      minVersion: "TLSv1.2",
      ciphers: [
        TLS13_SUITES,
        "ECDHE-ECDSA-AES128-GCM-SHA256",
        "ECDHE-RSA-AES128-GCM-SHA256",
        "ECDHE-ECDSA-AES256-GCM-SHA384",
        "ECDHE-RSA-AES256-GCM-SHA384",
        "ECDHE-ECDSA-CHACHA20-POLY1305",
        "ECDHE-RSA-CHACHA20-POLY1305",
        "ECDHE-RSA-AES128-SHA",
        "ECDHE-RSA-AES256-SHA",
        "AES128-GCM-SHA256",
        "AES256-GCM-SHA384",
        "AES128-SHA",
        "AES256-SHA"
      ].join(":"),
      ecdhCurve: "X25519:prime256v1:secp384r1",
      sigalgs: "ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha512",
      ALPNProtocols: ["h2", "http/1.1"]
    }
  },
  "firefox-like": {
    label: "Firefox-like",
    description:
      "Cipher and curve ordering approximating Firefox. Same caveat as chrome-like: ordering only.",
    connect: {
      minVersion: "TLSv1.2",
      ciphers: [
        TLS13_SUITES,
        "ECDHE-ECDSA-AES128-GCM-SHA256",
        "ECDHE-RSA-AES128-GCM-SHA256",
        "ECDHE-ECDSA-CHACHA20-POLY1305",
        "ECDHE-RSA-CHACHA20-POLY1305",
        "ECDHE-ECDSA-AES256-GCM-SHA384",
        "ECDHE-RSA-AES256-GCM-SHA384",
        "ECDHE-ECDSA-AES256-SHA",
        "ECDHE-ECDSA-AES128-SHA",
        "ECDHE-RSA-AES128-SHA",
        "ECDHE-RSA-AES256-SHA",
        "AES128-GCM-SHA256",
        "AES256-GCM-SHA384",
        "AES128-SHA",
        "AES256-SHA"
      ].join(":"),
      ecdhCurve: "X25519:prime256v1:secp384r1:secp521r1:ffdhe2048:ffdhe3072",
      ALPNProtocols: ["h2", "http/1.1"]
    }
  },
  "compat-legacy": {
    label: "Legacy compatible",
    description:
      "Allows TLS 1.2 with a broad cipher list. For a provider or middlebox that rejects a 1.3-only hello.",
    connect: {
      minVersion: "TLSv1.2",
      ciphers: "DEFAULT:@SECLEVEL=1",
      ALPNProtocols: ["http/1.1"]
    }
  }
};

export const TLS_PROFILE_IDS = Object.keys(TLS_PROFILES);

export function validateTlsProfile(name) {
  if (name === null || name === undefined || name === "" || name === "default") {
    return { ok: true, value: "default" };
  }
  if (!TLS_PROFILES[name]) {
    return { ok: false, error: `unknown TLS profile "${name}" (use ${TLS_PROFILE_IDS.join(", ")})` };
  }
  return { ok: true, value: name };
}

// The connect options for a profile, or null for stock behaviour. null is
// meaningful: it means "build no custom Agent at all", which keeps the default
// path on undici's shared global dispatcher and its connection pooling.
export function connectOptionsFor(profileName) {
  return TLS_PROFILES[profileName]?.connect ?? null;
}

export function tlsStatus(activeProfile) {
  const profile = TLS_PROFILES[activeProfile] || TLS_PROFILES.default;
  return {
    active: TLS_PROFILES[activeProfile] ? activeProfile : "default",
    label: profile.label,
    description: profile.description,
    profiles: TLS_PROFILE_IDS.map((id) => ({
      id,
      label: TLS_PROFILES[id].label,
      description: TLS_PROFILES[id].description
    })),
    // Stated on the API surface, not only in a source comment, because the
    // difference between "different fingerprint" and "passes as a browser" is
    // exactly what someone turning this on is likely to get wrong.
    caveat:
      "Shapes this process's own ClientHello (ciphers, curves, sigalgs, ALPN order). " +
      "Not browser impersonation: Node cannot emit GREASE values or control TLS extension " +
      "ordering, so a strict JA3 allowlist will still tell this apart from a real browser. " +
      "No TLS interception is performed in either direction."
  };
}
