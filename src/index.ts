import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getClaudeStatus } from "./claude-cli.ts";
import { claudeCodeEnv, createClaudeCodeProvider, PROVIDER_ID } from "./provider.ts";
import { composeStatus, latestRateLimit, STATUS_KEY } from "./usage-status.ts";

function renderUsage(ctx: ExtensionContext, provider: string | undefined): void {
  if (!ctx.hasUI) return;
  if (provider !== PROVIDER_ID) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  const { text, color } = composeStatus(latestRateLimit());
  ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, text));
}

export default function claudeCodeExtension(pi: ExtensionAPI): void {
  pi.registerProvider(createClaudeCodeProvider());

  pi.on("session_start", async (_event, ctx) => renderUsage(ctx, ctx.model?.provider));
  pi.on("model_select", async (event, ctx) => renderUsage(ctx, event.model.provider));
  pi.on("turn_end", async (_event, ctx) => renderUsage(ctx, ctx.model?.provider));

  pi.registerCommand("claude-code-status", {
    description: "Check the Claude Code executable and subscription login",
    handler: async (_args, ctx) => {
      const status = await getClaudeStatus(claudeCodeEnv(), ctx.signal);
      if (!status.available || !status.loggedIn) {
        ctx.ui.notify(status.detail ?? "Claude Code is not ready", "error");
        return;
      }
      const plan = status.plan ? ` (${status.plan})` : "";
      ctx.ui.notify(`Claude Code is installed and logged in${plan}`, "info");
    },
  });
}

export { createClaudeCodeProvider } from "./provider.ts";
export { streamClaudeCode } from "./stream.ts";
