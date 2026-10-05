// The environment a child process starts with: what a program needs to run
// (paths, temp dirs, locale, proxy and CA settings) and nothing else.
//
// Children used to inherit the gateway's whole environment, and that is where
// the secrets live: every provider API key, TOLLPIKE_SECRET (which decrypts
// the settings file and keys the audit chain) and the vendor audit
// credentials. A downstream MCP server or a sidecar binary had no need for
// any of them, and a compromised or careless one would have had all of them.
// What a child does need it gets by name, in its own configuration.

const EXACT = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "OS",
  "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
  "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432",
  "USER", "USERNAME", "LOGNAME", "USERDOMAIN", "COMPUTERNAME", "SHELL", "TERM",
  "LANG", "LANGUAGE", "TZ",
  "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE"
]);
const PREFIXES = ["LC_", "XDG_"];

export function baseChildEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string") continue;
    const K = k.toUpperCase();
    if (EXACT.has(K) || PREFIXES.some((p) => K.startsWith(p))) out[k] = v;
  }
  return out;
}
