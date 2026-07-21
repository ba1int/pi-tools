import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  MAX_CAPTURE_BYTES,
  JsonEventCollector,
  ReactiveRescueState,
  buildSeniorPrompt,
  normalizeBudget,
  normalizeSeniorRequest,
  normalizeRescueLimit,
  normalizeSeniorTimeout,
  parseHandback,
  rescueFingerprint,
} from "./core.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SSH_EXTENSION = join(ROOT, "..", "ssh-direct", "index.ts");
const BUDGET_EXTENSION = join(ROOT, "budget.ts");

function piInvocation() {
  const current = process.argv[1];
  return current && !current.startsWith("/$bunfs/")
    ? { command: process.execPath, prefix: [current] }
    : { command: "pi", prefix: [] };
}

function runSenior(request, options, signal, onUpdate, cwd) {
  return new Promise((resolve, reject) => {
    const invocation = piInvocation();
    const args = [
      ...invocation.prefix,
      "--mode", "json", "--print", "--no-session", "--no-approve",
      "--model", options.model, "--thinking", options.thinking,
      "--no-extensions", "--extension", SSH_EXTENSION, "--extension", BUDGET_EXTENSION,
      "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
      "--no-builtin-tools", "--tools", "ssh_exec",
      buildSeniorPrompt(request),
    ];
    const child = spawn(invocation.command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_SENIOR_CHILD: "1",
        PI_SSH_ALLOWED_HOSTS: request.allowed_hosts.join(","),
        PI_SSH_READ_ONLY: request.mutation_authorized ? "0" : "1",
        PI_SENIOR_MAX_TOOL_CALLS: String(options.maxToolCalls),
        PI_THINKING_ROUTER: "off",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
      },
    });
    const transcript = new JsonEventCollector();
    const stderr = [];
    let stderrBytes = 0;
    let timedOut = false;
    const capture = (target, chunk, bytes) => {
      if (bytes < MAX_CAPTURE_BYTES) target.push(chunk.subarray(0, MAX_CAPTURE_BYTES - bytes));
      return bytes + chunk.length;
    };
    child.stdout.on("data", (chunk) => {
      transcript.push(chunk);
      onUpdate?.({ content: [{ type: "text", text: "Senior rescue running…" }] });
    });
    child.stderr.on("data", (chunk) => { stderrBytes = capture(stderr, chunk, stderrBytes); });
    child.on("error", reject);
    const terminate = () => child.kill("SIGTERM");
    const timer = setTimeout(() => { timedOut = true; terminate(); }, options.timeoutSeconds * 1_000);
    const onAbort = () => terminate();
    if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        code: code ?? 1,
        timedOut,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stderrTruncated: stderrBytes > MAX_CAPTURE_BYTES,
        transcript: transcript.finish(),
      });
    });
  });
}

export default function seniorRescue(pi: ExtensionAPI) {
  if (process.env.PI_SENIOR_CHILD === "1") return;
  const used = new Set<string>();
  const maximumRescues = normalizeRescueLimit(process.env.PI_SENIOR_MAX_RESCUES);
  const reactive = new ReactiveRescueState();

  pi.on("session_start", async () => {
    reactive.reset();
    used.clear();
  });

  pi.on("input", async (event) => {
    reactive.noteInput(event);
    return { action: "continue" as const };
  });

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "ssh_exec") return;
    reactive.noteHost((event.input as { host?: unknown })?.host);
  });

  pi.on("agent_end", async (event) => {
    reactive.noteFinal(event.messages);
  });

  pi.on("agent_settled", async () => {
    const followUp = reactive.takeFollowUp();
    if (followUp) pi.sendUserMessage(followUp, { deliverAs: "followUp" });
  });

  pi.registerTool({
    name: "senior_rescue",
    label: "senior rescue",
    description: "Temporarily lease one observed blocker to a bounded Sol senior, then return control and a structured handback to the current Luna operator. Use only after concrete evidence and at least one sensible Luna attempt failed or the blocker is genuinely ambiguous; never use preemptively or for routine work.",
    promptSnippet: "Resolve one evidenced operations blocker with a bounded senior lease",
    promptGuidelines: [
      "Use senior_rescue only for one concrete blocker after Luna has gathered evidence and cannot safely progress; include verified current state, failed attempts, and the exact allowed SSH hosts.",
      "After senior_rescue returns, independently verify the affected checkpoint with ssh_exec before continuing. Do not treat the handback as proof.",
      "Do not call senior_rescue twice for the same blocker, and do not use it for ordinary uncertainty that one targeted check can resolve.",
    ],
    parameters: Type.Object({
      objective: Type.String({ minLength: 3, maxLength: 12000 }),
      blocker: Type.String({ minLength: 3, maxLength: 12000 }),
      current_state: Type.String({ minLength: 3, maxLength: 12000 }),
      failed_attempts: Type.Optional(Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 6 })),
      constraints: Type.Optional(Type.String({ maxLength: 4000 })),
      mutation_authorized: Type.Boolean({ description: "True only when the original user task authorizes necessary in-scope mutation." }),
      allowed_hosts: Type.Array(Type.String({ minLength: 1, maxLength: 320 }), { minItems: 1, maxItems: 8 }),
      max_tool_calls: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
      timeout_seconds: Type.Optional(Type.Integer({ minimum: 30, maximum: 600 })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const request = normalizeSeniorRequest(params);
      const fingerprint = rescueFingerprint(request);
      if (used.size >= maximumRescues) {
        return { content: [{ type: "text", text: `Senior rescue denied: this task exhausted its ${maximumRescues}-lease session budget. Stop safely or ask the operator.` }], isError: true };
      }
      if (used.has(fingerprint)) {
        return { content: [{ type: "text", text: "Senior rescue denied: this exact blocker already used its one rescue lease. Re-read live state or stop safely." }], isError: true };
      }
      used.add(fingerprint);
      const options = {
        model: process.env.PI_SENIOR_MODEL ?? "openai-codex/gpt-5.6-sol",
        thinking: process.env.PI_SENIOR_THINKING ?? "high",
        maxToolCalls: normalizeBudget(params.max_tool_calls),
        timeoutSeconds: normalizeSeniorTimeout(params.timeout_seconds),
      };
      const result = await runSenior(request, options, signal, onUpdate, ctx.cwd);
      const transcript = result.transcript;
      let handback;
      try { handback = parseHandback(transcript.finalText, request.allowed_hosts); }
      catch (error) {
        return {
          content: [{ type: "text", text: `Senior rescue failed closed: ${error.message}. Luna must inspect current state before taking further action.` }],
          details: {
            code: result.code, timedOut: result.timedOut,
            stderr: result.stderr.slice(-4000), stderrTruncated: result.stderrTruncated,
            ...transcript,
            request: { objective: request.objective, blocker: request.blocker, allowed_hosts: request.allowed_hosts, mutation_authorized: request.mutation_authorized },
            options, parseError: error.message,
          },
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(handback, null, 2) }],
        details: {
          code: result.code, timedOut: result.timedOut,
          stderr: result.stderr.slice(-4000), stderrTruncated: result.stderrTruncated,
          ...transcript,
          request: { objective: request.objective, blocker: request.blocker, allowed_hosts: request.allowed_hosts, mutation_authorized: request.mutation_authorized },
          options, handback,
        },
        isError: result.code !== 0 || result.timedOut || result.stderrTruncated || transcript.oversizedLine,
      };
    },
  });
}
