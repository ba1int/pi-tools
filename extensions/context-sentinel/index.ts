import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  COMPACTION_INSTRUCTIONS,
  CONTEXT_CHECKPOINT_EVENT,
  CONTINUATION_PROMPT,
  ContextSentinelState,
  YIELD_PROMPT,
  normalizeThreshold,
  sentinelEnabled,
} from "./core.js";

export default function contextSentinel(pi: ExtensionAPI) {
  if (!sentinelEnabled(process.env.PI_CONTEXT_SENTINEL)) return;

  const threshold = normalizeThreshold(process.env.PI_CONTEXT_SENTINEL_PERCENT);
  const state = new ContextSentinelState(threshold);

  const publishCheckpoint = (pending: boolean) => {
    pi.events.emit(CONTEXT_CHECKPOINT_EVENT, { pending });
  };

  const continueTask = (content: string) => {
    // Pi executes onComplete inside the compaction try/catch. Starting a new
    // turn synchronously there can make a successful compaction look failed.
    setTimeout(() => {
      try {
        pi.sendMessage({
          customType: "context-sentinel",
          content,
          display: false,
        }, {
          deliverAs: "followUp",
          triggerTurn: true,
        });
      } catch {
        // The operator may have switched or closed the session after compacting.
      }
    }, 0);
  };

  pi.on("session_start", async () => {
    state.reset();
    publishCheckpoint(false);
  });

  pi.on("turn_end", async (event, ctx) => {
    if (ctx.mode !== "tui") return;
    const observation = state.observe(ctx.getContextUsage(), {
      hasToolResults: event.toolResults.length > 0,
    });
    if (!observation.trigger) return;
    publishCheckpoint(true);

    if (ctx.hasUI) {
      ctx.ui.notify(
        `Context ${Math.round(observation.percent ?? threshold)}% · checkpointing before the next operation`,
        "info",
      );
    }

    pi.sendMessage({
      customType: "context-sentinel",
      content: YIELD_PROMPT,
      display: false,
    }, {
      deliverAs: "steer",
      triggerTurn: true,
    });
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (ctx.mode !== "tui" || !state.beginCompaction()) return;

    ctx.compact({
      customInstructions: COMPACTION_INSTRUCTIONS,
      onComplete: () => {
        state.complete();
        publishCheckpoint(false);
        continueTask(CONTINUATION_PROMPT);
      },
      onError: (error) => {
        state.fail();
        publishCheckpoint(false);
        if (ctx.hasUI) {
          ctx.ui.notify(`Context checkpoint failed: ${error.message}`, "warning");
        }
        continueTask(
          "Automatic context checkpoint failed. Continue the current task carefully from live state; do not repeat completed mutations.",
        );
      },
    });
  });
}
