import { spawn } from "node:child_process";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  BoundedCapture,
  classifySshFailure,
  connectionReuseEnabled,
  enforceAllowedHost,
  formatResult,
  isTransportFailureKind,
  looksLikeRawRemoteTransport,
  normalizeOutputLimit,
  normalizeTimeout,
  remoteProgram,
  sanitizeTerminalText,
  sshArgs,
  validateCommand,
} from "./core.js";

type ExecResult = {
  host: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  timedOut: boolean;
};

async function prepareControlPath(): Promise<string | undefined> {
  if (!connectionReuseEnabled(process.env.PI_SSH_MULTIPLEXING)) return undefined;

  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const directory = process.env.PI_SSH_CONTROL_DIR ?? `/tmp/pi-ssh-${uid ?? process.pid}`;
  if (!isAbsolute(directory)) return undefined;

  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return undefined;
    if (uid !== undefined && metadata.uid !== uid) return undefined;
    if ((metadata.mode & 0o077) !== 0) await chmod(directory, 0o700);
    return join(directory, "%C");
  } catch {
    // Reuse is an optimization. SSH must remain available if the local
    // filesystem cannot safely host an OpenSSH control socket.
    return undefined;
  }
}

function executeSsh(
  host: string,
  command: string,
  timeoutSeconds: number,
  maxOutputBytes: number,
  controlPath: string | undefined,
  signal?: AbortSignal,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn("ssh", sshArgs(host, { controlPath }), { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = new BoundedCapture(maxOutputBytes);
    const stderr = new BoundedCapture(maxOutputBytes);
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const terminate = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutSeconds * 1000);
    const onAbort = () => terminate();

    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        reject(new Error("ssh_exec aborted"));
        return;
      }
      resolve({
        host,
        exitCode,
        stdout: stdout.text(),
        stderr: stderr.text(),
        elapsedMs: Date.now() - startedAt,
        timedOut,
      });
    });

    child.stdin.end(remoteProgram(command));
  });
}

export default function sshDirect(pi: ExtensionAPI) {
  const controlPath = prepareControlPath();

  pi.registerTool({
    name: "ssh_exec",
    label: "ssh_exec",
    description:
      "Execute a targeted Bash program on one explicit remote SSH host. Use this directly whenever the user or a loaded skill names a remote host; no SSH mode or slash command is required.",
    promptSnippet: "Execute bounded Bash on an explicit SSH host without entering an SSH mode",
    promptGuidelines: [
      "For remote work, call ssh_exec with the literal host instead of invoking ssh, scp, sftp, or rsync through local bash.",
      "Call ssh_exec tools in parallel when independent checks are needed on multiple hosts.",
      "For one host, prefer one compact composite ssh_exec call that gathers all task-relevant evidence. Make a follow-up call only when the first result leaves a material question unanswered.",
      "Use the commands, paths, and probes supplied by a loaded skill or runbook before rediscovering a service implementation.",
      "If a usual utility or init system is absent, switch once to a portable fallback; do not repeatedly enumerate replacement tools.",
      "Keep remote commands targeted. Do not dump broad environment, package, process, or filesystem listings unless the task requires them.",
    ],
    parameters: Type.Object({
      host: Type.String({
        minLength: 1,
        maxLength: 320,
        description: "Literal SSH alias, hostname, or user@host. Never a shell expression.",
      }),
      command: Type.String({
        minLength: 1,
        description: "Bash program to execute remotely. It is sent over stdin to bash -se.",
      }),
      timeout_seconds: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 120,
        description: "Deadline for this remote call. Defaults to 30 seconds.",
      })),
      max_output_bytes: Type.Optional(Type.Integer({
        minimum: 1024,
        maximum: 32768,
        description: "Maximum rendered result size. Defaults to 16384 bytes.",
      })),
    }),
    async execute(_toolCallId, params, signal) {
      const host = enforceAllowedHost(params.host);
      const command = validateCommand(params.command);
      const timeoutSeconds = normalizeTimeout(params.timeout_seconds);
      const maxOutputBytes = normalizeOutputLimit(params.max_output_bytes);
      const resolvedControlPath = await controlPath;
      const result = await executeSsh(
        host,
        command,
        timeoutSeconds,
        maxOutputBytes,
        resolvedControlPath,
        signal,
      );
      const failureKind = classifySshFailure(result);
      const rendered = formatResult({ ...result, maxOutputBytes, failureKind });
      return {
        content: [{ type: "text", text: rendered.text }],
        details: {
          host,
          exitCode: result.exitCode,
          elapsedMs: result.elapsedMs,
          timedOut: result.timedOut,
          truncated: rendered.truncated,
          originalBytes: rendered.originalBytes,
          connectionReuseEnabled: Boolean(resolvedControlPath),
          failureKind,
          transportError: isTransportFailureKind(failureKind),
        },
      };
    },
    renderCall(args, theme) {
      const host = typeof args?.host === "string" ? args.host : "...";
      const command = typeof args?.command === "string"
        ? sanitizeTerminalText(args.command).trim().split("\n", 1)[0].slice(0, 100)
        : "...";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("ssh_exec"))} ${theme.fg("accent", host)} ${theme.fg("muted", command)}`,
        0,
        0,
      );
    },
  });

  pi.on("before_agent_start", async (event) => ({
    systemPrompt:
      event.systemPrompt
      + "\n\nRemote execution is stateless. When the user or a loaded skill identifies a remote host, call ssh_exec directly with that literal host. Never ask the user to enter an SSH mode or slash command. Never invoke ssh, scp, sftp, or rsync through local bash. For one host, prefer one compact task-focused call and follow up only when evidence is materially incomplete. Obey loaded skills before rediscovering service internals. Use parallel ssh_exec calls for independent hosts and keep output targeted.",
  }));

  pi.on("tool_call", async (event) => {
    if (!isToolCallEventType("bash", event)) return;
    if (!looksLikeRawRemoteTransport(event.input.command)) return;
    return {
      block: true,
      reason:
        "Model-generated raw SSH transport is disabled. Retry now with ssh_exec and include the literal host; do not ask the user for an SSH mode or slash command.",
    };
  });
}
