import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CONTEXT_CHECKPOINT_EVENT,
  ContextSentinelState,
  compactionInstructions,
  sentinelEnabled,
} from "./core.js";
import { resolveLedgerPath } from "../task-ledger/core.js";

export default function contextSentinel(pi: ExtensionAPI) {
  if (!sentinelEnabled(process.env.PI_CONTEXT_SENTINEL)) return;

  const state = new ContextSentinelState();

  const publishCheckpoint = (pending: boolean, status = pending ? "running" : "ok", reason = "threshold") => {
    pi.events.emit(CONTEXT_CHECKPOINT_EVENT, {
      pending,
      status,
      reason,
      count: state.compactions,
    });
  };

  const ledgerSnapshot = () => {
    try {
      return JSON.parse(readFileSync(resolveLedgerPath(), "utf8"));
    } catch {
      return null;
    }
  };

  pi.on("session_start", async () => {
    state.reset();
    publishCheckpoint(false);
  });

  pi.on("session_before_compact", async (event) => {
    if (event.reason !== "manual") {
      state.begin(event.reason);
      publishCheckpoint(true, "running", event.reason);
    }
    return { customInstructions: compactionInstructions(ledgerSnapshot()) };
  });

  pi.on("session_compact", async (event, ctx) => {
    if (!state.compacting) return;
    const reason = state.reason || event.reason;
    state.complete();
    publishCheckpoint(false, "ok", reason);
    if (ctx.hasUI && state.compactions > 1) {
      ctx.ui.notify(`Context checkpoint ${state.compactions} complete · verify long-task continuity`, "info");
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!state.compacting) return;
    const reason = state.reason || "threshold";
    state.fail();
    publishCheckpoint(false, "fail", reason);
    if (ctx.hasUI) {
      ctx.ui.notify("Context checkpoint failed closed · no further tools were run", "warning");
    }
  });
}
