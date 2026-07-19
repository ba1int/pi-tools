import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RoutingState } from "./core.js";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

function isDisabled() {
  return /^(?:0|off|false)$/i.test(process.env.PI_THINKING_ROUTER ?? "");
}

const ROUTES = {
  routine: {
    provider: process.env.PI_ROUTER_ROUTINE_PROVIDER ?? "openai-codex",
    model: process.env.PI_ROUTER_ROUTINE_MODEL ?? "gpt-5.6-luna",
    thinking: "medium" as ThinkingLevel,
  },
  frontier: {
    provider: process.env.PI_ROUTER_FRONTIER_PROVIDER ?? "openai-codex",
    model: process.env.PI_ROUTER_FRONTIER_MODEL ?? "gpt-5.6-sol",
    thinking: "high" as ThinkingLevel,
  },
};

function assistantText(messages: unknown[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string; content?: Array<{ type?: string; text?: string }> };
    if (message?.role !== "assistant") continue;
    return (message.content ?? [])
      .filter((item) => item.type === "text")
      .map((item) => item.text ?? "")
      .join("\n");
  }
  return "";
}

export default function thinkingRouter(pi: ExtensionAPI) {
  if (isDisabled()) return;

  const state = new RoutingState();
  let pendingSelection: ThinkingLevel | null = null;
  let pendingModel: string | null = null;
  let finalReport = "";

  const status = (ctx: { hasUI: boolean; ui: { setStatus: (key: string, value?: string) => void } }) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(
      "thinking-router",
      `${state.mode} ${state.tier}/${state.level} · ${state.reason}`,
    );
  };

  const select = async (
    tier: "routine" | "frontier",
    level: ThinkingLevel,
    reason: string,
    ctx: Parameters<typeof status>[0] & {
      model?: { provider?: string; id?: string };
      modelRegistry: { find: (provider: string, model: string) => unknown };
    },
  ) => {
    const route = ROUTES[tier];
    const model = ctx.modelRegistry.find(route.provider, route.model);
    if (!model) {
      if (tier === "routine") {
        if (ctx.hasUI) ctx.ui.notify(`Router model unavailable: ${route.provider}/${route.model}`, "warning");
        return select("frontier", "high", `missing ${route.provider}/${route.model}; conservative fallback`, ctx);
      }
      state.tier = "frontier";
      state.level = "high";
      state.reason = `missing ${route.provider}/${route.model}; conservative fallback`;
      if (ctx.hasUI) ctx.ui.notify(`Router model unavailable: ${route.provider}/${route.model}`, "warning");
      status(ctx);
      return false;
    }
    state.tier = tier;
    state.level = level;
    state.reason = reason;
    if (ctx.model?.provider !== route.provider || ctx.model?.id !== route.model) {
      pendingModel = `${route.provider}/${route.model}`;
      const selected = await pi.setModel(model as Parameters<typeof pi.setModel>[0]);
      if (!selected) {
        pendingModel = null;
        state.tier = "frontier";
        state.level = "high";
        state.reason = `authentication unavailable for ${route.provider}/${route.model}`;
        status(ctx);
        return false;
      }
    }
    if (pi.getThinkingLevel() !== level) {
      pendingSelection = level;
      pi.setThinkingLevel(level);
    }
    status(ctx);
    return true;
  };

  pi.on("session_start", async (_event, ctx) => {
    state.reset();
    pendingSelection = null;
    pendingModel = null;
    finalReport = "";
    status(ctx);
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || event.streamingBehavior) return { action: "continue" as const };
    const decision = state.route(event.text);
    await select(state.tier, decision.level as ThinkingLevel, decision.reason, ctx);
    return { action: "continue" as const };
  });

  pi.on("model_select", async (event, ctx) => {
    const selected = `${event.model.provider}/${event.model.id}`;
    if (pendingModel === selected) {
      pendingModel = null;
      status(ctx);
      return;
    }
    pendingModel = null;
    state.mode = "manual";
    state.tier = selected === `${ROUTES.routine.provider}/${ROUTES.routine.model}` ? "routine" : "frontier";
    state.reason = "manual model override";
    status(ctx);
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    if (pendingSelection !== null) {
      pendingSelection = null;
      state.level = event.level;
      status(ctx);
      return;
    }
    state.setManual(state.tier, event.level);
    status(ctx);
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "ssh_exec") return;
    const input = event.input as { command?: string };
    state.noteRemoteCommand(input.command ?? "");
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "ssh_exec") return;
    const details = event.details as {
      exitCode?: number | null;
      timedOut?: boolean;
      transportError?: boolean;
    } | undefined;
    const escalation = state.noteRemoteResult({
      isError: event.isError,
      timedOut: details?.timedOut,
      exitCode: details?.exitCode,
      transportError: details?.transportError,
    });
    if (escalation) await select("frontier", "high", escalation.reason, ctx);
  });

  pi.on("agent_end", async (event) => {
    finalReport = assistantText(event.messages as unknown[]);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const escalation = state.noteFinalResult(finalReport);
    finalReport = "";
    if (!escalation) return;
    const selected = await select("frontier", "high", escalation.reason, ctx);
    if (!selected) return;
    pi.sendUserMessage(
      "Automatic escalation: the bounded worker stopped without a recognized hard safety block. Re-read the live state and loaded runbook. Continue the task if safe; otherwise preserve or roll back partial state and report the exact hard block. Do not override ownership conflicts, unsupported topology, or missing change authority.",
      { deliverAs: "followUp" },
    );
  });

  pi.registerCommand("think", {
    description: "Show or override automatic model routing (auto|luna|sol)",
    getArgumentCompletions: (prefix) => {
      const values = ["auto", "luna", "sol", "status"];
      const matches = values.filter((value) => value.startsWith(prefix));
      return matches.length ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const choice = args.trim().toLowerCase() || "status";
      if (choice === "auto") {
        state.setAuto();
        status(ctx);
      } else if (choice === "luna" || choice === "sol") {
        const tier = choice === "luna" ? "routine" : "frontier";
        const route = ROUTES[tier];
        state.setManual(tier, route.thinking);
        await select(tier, route.thinking, "manual override", ctx);
      } else if (choice !== "status") {
        ctx.ui.notify("Usage: /think auto|luna|sol|status", "warning");
        return;
      }
      ctx.ui.notify(`Router: ${state.mode} ${state.tier}/${state.level} (${state.reason})`, "info");
    },
  });
}
