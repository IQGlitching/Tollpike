// The connector registry. Each entry is documented in its own file with the
// vendor documentation it was built from and the date that was checked.

import { openaiPlatform, chatgptEnterprise } from "./connectors/openai.js";
import { anthropicCompliance, anthropicAdmin } from "./connectors/anthropic.js";
import { microsoftCopilot, microsoftCopilotChat } from "./connectors/microsoft.js";
import { githubCopilot } from "./connectors/github.js";
import { googleGemini } from "./connectors/google.js";
import { cursorAudit } from "./connectors/cursor.js";

export const CONNECTORS = Object.fromEntries(
  [chatgptEnterprise, openaiPlatform, anthropicCompliance, anthropicAdmin, microsoftCopilot, microsoftCopilotChat, githubCopilot, googleGemini, cursorAudit].map((c) => [c.id, c])
);
