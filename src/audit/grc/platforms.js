// Compliance platforms Tollpike can push evidence to. Each file names the
// documentation it was built from and the date it was checked.

import { vanta } from "./vanta.js";
import { drata } from "./drata.js";

export const PLATFORMS = Object.fromEntries([vanta, drata].map((p) => [p.id, p]));
