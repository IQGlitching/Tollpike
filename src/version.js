// The one place the running version comes from: package.json. It used to be
// written out by hand in six files, and a release that bumps one of them
// leaves the others reporting the old number.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");

export const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
