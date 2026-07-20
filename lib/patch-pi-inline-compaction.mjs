import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PATCH_MARKER = "pi-tools:inline-compaction:v1";

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Pi inline-compaction patch mismatch: ${label}`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

function replaceFirst(source, before, after, label) {
  const index = source.indexOf(before);
  if (index < 0) throw new Error(`Pi inline-compaction patch mismatch: ${label}`);
  return `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
}

export function patchPiInlineCompaction(manifestPath, expectedVersion) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== "@earendil-works/pi-coding-agent" || manifest.version !== expectedVersion) {
    throw new Error(`expected @earendil-works/pi-coding-agent@${expectedVersion}`);
  }

  const target = join(dirname(manifestPath), "dist", "core", "agent-session.js");
  let source = readFileSync(target, "utf8");
  if (source.includes(PATCH_MARKER)) return { changed: false, target };

  source = replaceOnce(
    source,
    "    _overflowRecoveryAttempted = false;\n    // Branch summarization state",
    `    _overflowRecoveryAttempted = false;\n    // ${PATCH_MARKER}\n    _inlineCompactionFailed = false;\n    // Branch summarization state`,
    "state field",
  );

  source = replaceOnce(
    source,
    `    _installAgentNextTurnRefresh() {
        const previousPrepareNextTurnWithContext = this.agent.prepareNextTurnWithContext ??
            (this.agent.prepareNextTurn
                ? async (_turn, signal) => await this.agent.prepareNextTurn?.(signal)
                : undefined);
        this.agent.prepareNextTurnWithContext = async (turn, signal) => {
            const previousSnapshot = await previousPrepareNextTurnWithContext?.(turn, signal);
            const previousContext = previousSnapshot?.context ?? turn.context;
            return {
                ...previousSnapshot,
                context: {
                    ...previousContext,
                    systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,
                    tools: this.agent.state.tools.slice(),
                },
                model: this.agent.state.model,
                thinkingLevel: this.agent.state.thinkingLevel,
            };
        };
    }`,
    `    _installAgentNextTurnRefresh() {
        const previousPrepareNextTurnWithContext = this.agent.prepareNextTurnWithContext ??
            (this.agent.prepareNextTurn
                ? async (_turn, signal) => await this.agent.prepareNextTurn?.(signal)
                : undefined);
        this.agent.prepareNextTurnWithContext = async (turn, signal) => {
            const previousSnapshot = await previousPrepareNextTurnWithContext?.(turn, signal);
            const previousContext = previousSnapshot?.context ?? turn.context;
            let nextMessages = previousContext.messages;
            if (await this._shouldCompactBeforeNextToolTurn(turn)) {
                const compacted = await this._runAutoCompaction("threshold", true);
                if (!compacted) {
                    this._inlineCompactionFailed = true;
                    throw new Error("Inline context compaction failed; stopped before the next model turn so no further tools can run.");
                }
                nextMessages = this.agent.state.messages.slice();
                const settings = this.settingsManager.getCompactionSettings();
                const contextWindow = this.model?.contextWindow ?? 0;
                const estimatedTokensAfter = estimateContextTokens(nextMessages).tokens;
                if (shouldCompact(estimatedTokensAfter, contextWindow, settings)) {
                    this._inlineCompactionFailed = true;
                    throw new Error(\`Inline context compaction left \${estimatedTokensAfter} tokens above the configured safe boundary; stopped before the next model turn.\`);
                }
            }
            return {
                ...previousSnapshot,
                context: {
                    ...previousContext,
                    messages: nextMessages,
                    systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,
                    tools: this.agent.state.tools.slice(),
                },
                model: this.agent.state.model,
                thinkingLevel: this.agent.state.thinkingLevel,
            };
        };
    }
    async _shouldCompactBeforeNextToolTurn(turn) {
        if (turn.toolResults.length === 0 || turn.message.stopReason === "error" || turn.message.stopReason === "aborted") {
            return false;
        }
        const settings = this.settingsManager.getCompactionSettings();
        const contextWindow = this.model?.contextWindow ?? 0;
        if (!settings.enabled || contextWindow <= 0)
            return false;
        const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
        if (compactionEntry && turn.message.timestamp <= new Date(compactionEntry.timestamp).getTime()) {
            return false;
        }
        return shouldCompact(estimateContextTokens(turn.context.messages).tokens, contextWindow, settings);
    }`,
    "next-turn hook",
  );

  source = replaceOnce(
    source,
    `        if (!msg) {
            return false;
        }
        if (this._isRetryableError(msg)`,
    `        if (!msg) {
            return false;
        }
        if (this._inlineCompactionFailed) {
            this._inlineCompactionFailed = false;
            return false;
        }
        if (this._isRetryableError(msg)`,
    "fail-closed post-run guard",
  );

  source = replaceFirst(
    source,
    `            let extensionCompaction;
            let fromExtension = false;
            if (this._extensionRunner.hasHandlers("session_before_compact")) {`,
    `            let extensionCompaction;
            let fromExtension = false;
            let effectiveCustomInstructions = customInstructions;
            if (this._extensionRunner.hasHandlers("session_before_compact")) {`,
    "manual instruction state",
  );
  source = replaceOnce(
    source,
    `                if (result?.compaction) {
                    extensionCompaction = result.compaction;
                    fromExtension = true;
                }
            }
            let summary;`,
    `                if (result?.compaction) {
                    extensionCompaction = result.compaction;
                    fromExtension = true;
                }
                if (result?.customInstructions?.trim()) {
                    effectiveCustomInstructions = [effectiveCustomInstructions, result.customInstructions.trim()]
                        .filter(Boolean)
                        .join("\\n\\n");
                }
            }
            let summary;`,
    "manual extension instructions",
  );
  source = replaceOnce(
    source,
    "                const result = await compact(preparation, this.model, apiKey, headers, customInstructions, this._compactionAbortController.signal, this.thinkingLevel, this.agent.streamFn, env);",
    "                const result = await compact(preparation, this.model, apiKey, headers, effectiveCustomInstructions, this._compactionAbortController.signal, this.thinkingLevel, this.agent.streamFn, env);",
    "manual compact call",
  );

  source = replaceOnce(
    source,
    `            let extensionCompaction;
            let fromExtension = false;
            if (this._extensionRunner.hasHandlers("session_before_compact")) {`,
    `            let extensionCompaction;
            let fromExtension = false;
            let effectiveCustomInstructions;
            if (this._extensionRunner.hasHandlers("session_before_compact")) {`,
    "automatic instruction state",
  );
  source = replaceOnce(
    source,
    `                if (extensionResult?.compaction) {
                    extensionCompaction = extensionResult.compaction;
                    fromExtension = true;
                }
            }
            let summary;`,
    `                if (extensionResult?.compaction) {
                    extensionCompaction = extensionResult.compaction;
                    fromExtension = true;
                }
                if (extensionResult?.customInstructions?.trim()) {
                    effectiveCustomInstructions = extensionResult.customInstructions.trim();
                }
            }
            let summary;`,
    "automatic extension instructions",
  );
  source = replaceOnce(
    source,
    "                const compactResult = await compact(preparation, this.model, apiKey, headers, undefined, this._autoCompactionAbortController.signal, this.thinkingLevel, this.agent.streamFn, env);",
    "                const compactResult = await compact(preparation, this.model, apiKey, headers, effectiveCustomInstructions, this._autoCompactionAbortController.signal, this.thinkingLevel, this.agent.streamFn, env);",
    "automatic compact call",
  );
  source = replaceOnce(
    source,
    `                details = compactResult.details;
            }
            if (this._autoCompactionAbortController.signal.aborted) {`,
    `                details = compactResult.details;
            }
            if (!summary.trim()) {
                throw new Error("Compaction produced an empty summary");
            }
            if (this._autoCompactionAbortController.signal.aborted) {`,
    "summary validation",
  );

  const temporary = `${target}.pi-tools-${process.pid}`;
  const mode = statSync(target).mode;
  writeFileSync(temporary, source, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, target);
  return { changed: true, target };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [manifestPath, expectedVersion] = process.argv.slice(2);
  if (!manifestPath || !expectedVersion) {
    throw new Error("usage: patch-pi-inline-compaction.mjs MANIFEST EXPECTED_VERSION");
  }
  const result = patchPiInlineCompaction(manifestPath, expectedVersion);
  process.stdout.write(`${result.changed ? "patch" : "ok"}    ${result.target}\n`);
}
