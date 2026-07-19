import { existsSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  SIDE_BOUNDARY_TYPE,
  SIDE_TASK_TYPE,
  buildBoundary,
  buildLaunchCommand,
  buildZellijPaneArgs,
  findSideMetadata,
  isCompletedBranch,
  isFloatingSidePane,
  isInsideZellij,
  isReadOnlyTool,
  normalizeTask,
  reuseParentPromptCache,
  sideSessionName,
} from "./core.js";

type SideMetadata = {
  version: 1;
  parentSessionFile: string;
  parentSessionId: string;
  originEntryId: string;
  childSessionId: string;
  task: string;
  policy: "read-only";
  createdAt: string;
};

function currentMetadata(ctx: ExtensionContext): SideMetadata | undefined {
  return findSideMetadata(ctx.sessionManager.getBranch()) as SideMetadata | undefined;
}

async function askForTask(ctx: ExtensionContext, supplied: string): Promise<string | undefined> {
  if (supplied.trim()) return normalizeTask(supplied);
  const answer = await ctx.ui.input("Start a side conversation", "Question or bounded task");
  if (answer === undefined || !answer.trim()) return undefined;
  return normalizeTask(answer);
}

async function createSideTask(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  suppliedTask: string,
): Promise<void> {
  if (!ctx.isIdle()) {
    ctx.ui.notify("Wait for the current response to finish before starting an aside", "warning");
    return;
  }

  const task = await askForTask(ctx, suppliedTask);
  if (!task) return;

  const parentSessionFile = ctx.sessionManager.getSessionFile();
  const originEntryId = ctx.sessionManager.getLeafId();
  if (!parentSessionFile || !originEntryId || !existsSync(parentSessionFile)) {
    ctx.ui.notify("The current conversation must be saved before it can be cloned", "error");
    return;
  }

  const branch = ctx.sessionManager.getBranch();
  if (!isCompletedBranch(branch)) {
    ctx.ui.notify("An aside can start only after a completed assistant response", "warning");
    return;
  }

  try {
    const parentSessionId = ctx.sessionManager.getSessionId();
    const sideManager = SessionManager.open(parentSessionFile);
    const childSessionFile = sideManager.createBranchedSession(originEntryId);
    if (!childSessionFile) throw new Error("Pi did not create a persisted side session");

    const metadata: SideMetadata = {
      version: 1,
      parentSessionFile,
      parentSessionId,
      originEntryId,
      childSessionId: sideManager.getSessionId(),
      task,
      policy: "read-only",
      createdAt: new Date().toISOString(),
    };
    sideManager.appendCustomEntry(SIDE_TASK_TYPE, metadata);
    sideManager.appendCustomMessageEntry(
      SIDE_BOUNDARY_TYPE,
      buildBoundary(metadata),
      true,
      metadata,
    );
    sideManager.appendSessionInfo(sideSessionName(task));

    const launchCommand = buildLaunchCommand("pi", childSessionFile, task);
    if (isInsideZellij(process.env)) {
      try {
        const result = await pi.exec(
          "zellij",
          buildZellijPaneArgs(ctx.cwd, childSessionFile, task),
          { cwd: ctx.cwd, timeout: 10_000 },
        );
        if (result.code !== 0) {
          throw new Error(result.stderr.trim() || `zellij exited with status ${result.code}`);
        }
        ctx.ui.setWidget("pi-side-task-created", undefined);
        ctx.ui.notify("Side conversation opened in a floating Zellij pane", "info");
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Zellij launch failed; use the command shown below: ${message}`, "warning");
      }
    }

    ctx.ui.setWidget("pi-side-task-created", [
      "SIDE CONVERSATION READY · READ ONLY",
      "Open it in another terminal or Zellij pane:",
      launchCommand,
      "The parent conversation remains unchanged in this pane.",
    ], { placement: "belowEditor" });
    ctx.ui.notify("Side conversation created; the launch command is shown below", "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Could not create side conversation: ${message}`, "error");
  }
}

async function returnToParent(ctx: ExtensionCommandContext): Promise<void> {
  const metadata = currentMetadata(ctx);
  if (!metadata) {
    ctx.ui.notify("This is not a side conversation", "warning");
    return;
  }

  if (isFloatingSidePane(process.env)) {
    ctx.ui.notify("Closing the floating side conversation", "info");
    ctx.shutdown();
    return;
  }

  try {
    if (!existsSync(metadata.parentSessionFile)) throw new Error("parent session file no longer exists");
    const parent = SessionManager.open(metadata.parentSessionFile);
    if (parent.getSessionId() !== metadata.parentSessionId) {
      throw new Error("parent session identity does not match the recorded metadata");
    }
    await ctx.switchSession(metadata.parentSessionFile, {
      withSession: async (replacementCtx) => {
        replacementCtx.ui.notify("Returned to the parent conversation", "info");
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Could not return to parent: ${message}`, "error");
  }
}

export default function sideTaskExtension(pi: ExtensionAPI) {
  pi.registerCommand("btw", {
    description: "Start a read-only side question from the completed current branch",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      await createSideTask(pi, ctx, args);
    },
  });

  pi.registerCommand("aside", {
    description: "Alias for /btw: start a read-only side conversation",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      await createSideTask(pi, ctx, args);
    },
  });

  pi.registerShortcut("ctrl+shift+a", {
    description: "Start a read-only side conversation",
    handler: async (ctx) => createSideTask(pi, ctx, ""),
  });

  pi.registerCommand("aside-return", {
    description: "Close a floating aside or switch a manual side session back to its parent",
    handler: async (_args, ctx) => returnToParent(ctx),
  });

  pi.on("session_start", (_event, ctx) => {
    const metadata = currentMetadata(ctx);
    if (!metadata) return;
    if (ctx.mode === "rpc") {
      ctx.ui.notify(
        "Side conversations refuse RPC mode because Pi's direct RPC bash command bypasses interactive shell hooks",
        "error",
      );
      process.exit(2);
    }
    ctx.ui.setStatus("pi-side-task", "ASIDE · READ ONLY");
    const returnHint = isFloatingSidePane(process.env)
      ? "Use /aside-return or Ctrl+D to close this float and reveal the parent."
      : "Use /aside-return to switch this pane back. If the parent is open elsewhere, exit this pane instead.";
    ctx.ui.setWidget("pi-side-task", [
      `SIDE CONVERSATION · ${metadata.task}`,
      `Parent ${metadata.parentSessionId} · origin ${metadata.originEntryId}`,
      returnHint,
    ]);
  });

  pi.on("before_provider_request", (event, ctx) => {
    const metadata = currentMetadata(ctx);
    if (!metadata) return;
    return reuseParentPromptCache(
      event.payload,
      ctx.sessionManager.getSessionId(),
      metadata.parentSessionId,
    );
  });

  pi.on("tool_call", (event, ctx) => {
    if (!currentMetadata(ctx) || isReadOnlyTool(event.toolName)) return;
    return {
      block: true,
      reason:
        `Side conversations are read-only by default. Tool ${event.toolName} is blocked; use read, grep, find, or ls only.`,
    };
  });

  pi.on("user_bash", (_event, ctx) => {
    if (!currentMetadata(ctx)) return;
    return {
      result: {
        output: "Side conversations block ! shell commands by default. Use Pi's read-only tools instead.",
        exitCode: 126,
        cancelled: false,
        truncated: false,
      },
    };
  });
}
