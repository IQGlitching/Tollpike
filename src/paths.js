import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Single source of truth for where state lives: usage.jsonl, settings.json
// and the encryption salt.
//
// Overridable so a test (or a second instance on the same machine) can get
// its own directory. The e2e suite used to delete the shared ./data between
// runs while the crypto suite was concurrently reading .salt from it — the
// salt would vanish mid-suite, the derived key would change, and a
// perfectly correct round-trip test would fail. That is one of the
// "cancelled / rerun it" symptoms in the handover, and it is a test
// isolation bug rather than a timing one.
export const dataDir = process.env.TOLLPIKE_DATA_DIR
  ? path.resolve(process.env.TOLLPIKE_DATA_DIR)
  : path.join(__dirname, "..", "data");
