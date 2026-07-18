import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RoutingState } from "./core.js";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

function isDisabled() {
  return /^(?:0|off|false)$/i.test(process.env.PI_THINKING_ROUTER ?? "");
}

export default function thinkingRouter(pi: ExtensionAPI) {
  if (isDisabled()) return;

  const state = new RoutingState();
  let pendingSelection: ThinkingLevel | null = null;

  const status = (ctx: { hasUI: boolean; ui: { setStatus: (key: string, value?: string) => void } }) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(
      "thinking-router",
      `${state.mode} ${state.level} · ${state.reason}`,
    );
  };

  const select = (level: ThinkingLevel, reason: string, ctx: Parameters<typeof status>[0]) => {
    state.level = level;
    state.reason = reason;
    if (pi.getThinkingLevel() !== level) {
      pendingSelection = level;
      pi.setThinkingLevel(level);
    }
    status(ctx);
  };

  pi.on("session_start", async (_event, ctx) => {
    state.reset();
    pendingSelection = null;
    status(ctx);
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || event.streamingBehavior) return { action: "continue" as const };
    const decision = state.route(event.text);
    select(decision.level as ThinkingLevel, decision.reason, ctx);
    return { action: "continue" as const };
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    if (pendingSelection !== null) {
      pendingSelection = null;
      state.level = event.level;
      status(ctx);
      return;
    }
    state.setManual(event.level);
    status(ctx);
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "ssh_exec") return;
    const input = event.input as { command?: string };
    state.noteRemoteCommand(input.command ?? "");
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "ssh_exec") return;
    const details = event.details as { exitCode?: number | null; timedOut?: boolean } | undefined;
    const escalation = state.noteRemoteResult({
      isError: event.isError,
      timedOut: details?.timedOut,
      exitCode: details?.exitCode,
    });
    if (escalation) select("high", escalation.reason, ctx);
  });

  pi.registerCommand("think", {
    description: "Show or override automatic thinking routing (auto|low|high)",
    getArgumentCompletions: (prefix) => {
      const values = ["auto", "low", "high", "status"];
      const matches = values.filter((value) => value.startsWith(prefix));
      return matches.length ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const choice = args.trim().toLowerCase() || "status";
      if (choice === "auto") {
        state.setAuto();
        status(ctx);
      } else if (choice === "low" || choice === "high") {
        state.setManual(choice);
        select(choice, "manual override", ctx);
      } else if (choice !== "status") {
        ctx.ui.notify("Usage: /think auto|low|high|status", "warning");
        return;
      }
      ctx.ui.notify(`Thinking: ${state.mode} ${state.level} (${state.reason})`, "info");
    },
  });
}
