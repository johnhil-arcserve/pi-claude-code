import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getClaudeStatus } from "./claude-cli.ts";
import { claudeCodeEnv, createClaudeCodeProvider, PROVIDER_ID } from "./provider.ts";
import {
  composeStatus,
  fetchSpend,
  latestRateLimit,
  spendPollDelay,
  STATUS_KEY,
  type SpendState,
} from "./usage-status.ts";

export default function claudeCodeExtension(pi: ExtensionAPI): void {
  pi.registerProvider(createClaudeCodeProvider());

  const spend: SpendState = { stale: false };
  let spendFailures = 0;
  let nextSpendFetch = 0;
  let spendInFlight = false;

  function renderUsage(ctx: ExtensionContext, provider: string | undefined): void {
    if (!ctx.hasUI) return;
    if (provider !== PROVIDER_ID) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const { text, color } = composeStatus(latestRateLimit(), spend);
    ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, text));
  }

  // Spend only matters while requests bill to usage credits; poll sparingly
  // because the usage endpoint rate-limits (429) under frequent polling.
  async function refreshSpend(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI || ctx.model?.provider !== PROVIDER_ID) return;
    if (latestRateLimit()?.isUsingOverage !== true) return;
    if (spendInFlight || Date.now() < nextSpendFetch) return;
    spendInFlight = true;
    try {
      spend.spend = await fetchSpend(claudeCodeEnv());
      spend.stale = false;
      spendFailures = 0;
    } catch {
      spend.stale = true;
      spendFailures += 1;
    } finally {
      spendInFlight = false;
      nextSpendFetch = Date.now() + spendPollDelay(spendFailures);
    }
    renderUsage(ctx, ctx.model?.provider);
  }

  pi.on("session_start", async (_event, ctx) => renderUsage(ctx, ctx.model?.provider));
  pi.on("model_select", async (event, ctx) => renderUsage(ctx, event.model.provider));
  pi.on("turn_end", async (_event, ctx) => {
    renderUsage(ctx, ctx.model?.provider);
    void refreshSpend(ctx);
  });

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
