const HIGH_SIGNALS = [
  /\b(?:incident|outage|degraded|critical|unknown|unexpected|intermittent)\b/i,
  /\b(?:investigat(?:e|ion)|diagnos(?:e|is)|root cause|troubleshoot|debug)\b/i,
  /\bwhy\s+(?:is|are|did|does|do|has|have|was|were)\b/i,
  /\b(?:failed|failing)\s+(?:check|checkpoint|validation|validator|deployment|change)\b/i,
  /\b(?:research|benchmark|compare|evaluate|audit)\b/i,
  /\b(?:create|write|design|review|improve|refactor|update)\b.{0,50}\b(?:runbook|skill|procedure|workflow)\b/i,
];

const ROUTINE_SIGNALS = [
  /\b(?:onboard|wire|register|provision)\b.{0,80}\b(?:host|server|node|icinga|nagios|monitoring)\b/i,
  /\b(?:restart|reload|rotate|deploy|roll out)\b.{0,80}\b(?:service|certificate|cert|application|app|release|config)/i,
  /\b(?:follow|use|using|apply|execute|run)\b.{0,50}\b(?:runbook|procedure|playbook|documented change)\b/i,
  /\baccording to\b.{0,50}\b(?:assignment|runbook|procedure|skill)\b/i,
  /\broutine\b.{0,50}\b(?:task|change|maintenance|onboarding|operation)\b/i,
  /\badd\b.{0,40}\bhost\b.{0,40}\b(?:icinga|nagios|monitoring)\b/i,
];

const CONTINUATION_WORDS = new Set([
  "yes", "yeah", "yep", "yup", "ok", "okay", "sure", "approved",
  "continue", "proceed", "go", "ahead", "do", "it", "that", "this",
  "looks", "sounds", "good", "awesome", "great", "perfect", "alright",
  "please", "now", "and", "make", "happen", "thanks", "thank", "you",
]);

const CONTINUATION_SIGNALS = new Set([
  "yes", "yeah", "yep", "yup", "ok", "okay", "sure", "approved",
  "continue", "proceed", "ahead", "do", "good", "awesome", "great",
  "perfect", "alright", "make",
]);

const MUTATION = /(?:^|[;&|]\s*)(?:sudo(?:\s+-\S+)*\s+)?(?:rm|rmdir|mv|cp|install|mkdir|touch|ln|chmod|chown|chgrp|truncate|tee|dd|sed\s+-i|perl\s+-i|systemctl\s+(?:restart|reload|stop|start|enable|disable)|service\s+\S+\s+(?:restart|reload|stop|start))\b|(?:^|[\s;|&])\d*>>?\s*(?!&?\d\b|\d+\b|\/dev\/(?:null|stdout|stderr)\b)[^\s;|&]+/i;

const OPERATIONAL_MUTATIONS = [
  /(?:^|[;&|]\s*)(?:sudo(?:\s+-\S+)*\s+)?(?:apt(?:-get)?\s+(?:install|remove|purge|upgrade|full-upgrade|dist-upgrade)|aptitude\s+(?:install|remove|purge|upgrade)|(?:dnf|yum|zypper)\s+(?:install|remove|erase|update|upgrade)|dpkg\s+(?:-i|-r|-P|--install|--remove|--purge)|rpm\s+(?:-i|-U|-e|--install|--upgrade|--erase))/i,
  /(?:^|[;&|]\s*)(?:sudo(?:\s+-\S+)*\s+)?(?:docker|podman)(?:\s+compose)?\s+(?:build|create|down|kill|pause|pull|push|restart|rm|rmi|run|start|stop|unpause|update|up)/i,
  /(?:^|[;&|]\s*)(?:sudo(?:\s+-\S+)*\s+)?(?:kubectl\s+(?:apply|create|delete|drain|edit|label|annotate|patch|replace|rollout|scale|set|taint|cordon|uncordon)|helm\s+(?:install|upgrade|uninstall|rollback))/i,
  /(?:^|[;&|]\s*)(?:sudo(?:\s+-\S+)*\s+)?(?:systemctl\s+(?:daemon-reload|daemon-reexec)|(?:useradd|usermod|userdel|groupadd|groupmod|groupdel|passwd|chpasswd)|(?:mount|umount|swapon|swapoff|crontab)|sysctl\s+-w)/i,
  /(?:^|[;&|]\s*)(?:sudo(?:\s+-\S+)*\s+)?(?:(?:iptables|ip6tables)\s+(?:-A|-I|-D|-R|-F|-X|-P|-N|--append|--insert|--delete|--replace|--flush|--delete-chain|--policy|--new-chain)|nft\s+(?:add|delete|insert|replace|flush|reset|import|-f)|ufw\s+(?:enable|disable|allow|deny|reject|limit|delete|reset|reload|route)|firewall-cmd\s+(?:--add|--remove|--reload|--complete-reload|--set|--new|--delete))/i,
];

function isBriefContinuation(text) {
  const words = String(text ?? "").toLowerCase().match(/[a-z]+/g) ?? [];
  return words.length > 0
    && words.length <= 9
    && words.every((word) => CONTINUATION_WORDS.has(word))
    && words.some((word) => CONTINUATION_SIGNALS.has(word));
}

export function classifyPrompt(text, previousLevel = "high") {
  const prompt = String(text ?? "").trim();
  if (isBriefContinuation(prompt)) {
    return { level: previousLevel, reason: "continuation", retained: true };
  }
  if (HIGH_SIGNALS.some((pattern) => pattern.test(prompt))) {
    return { tier: "frontier", level: "high", reason: "investigation or runbook engineering", retained: false };
  }
  if (ROUTINE_SIGNALS.some((pattern) => pattern.test(prompt))) {
    return { tier: "routine", level: "medium", reason: "bounded routine operation", retained: false };
  }
  return { tier: "frontier", level: "high", reason: "conservative default", retained: false };
}

const BLOCKED_RESULT = /\b(?:blocked|cannot|can't|could not|unable|stopped|did not proceed|no changes)\b/i;
const LEGITIMATE_STOP = [
  /\b(?:ownership conflict|belongs to (?:another|a different)|owned by (?:another|a different))\b/i,
  /\b(?:dual[- ]relay|active[- ]active|unsupported topology|not covered by (?:the )?runbook|outside (?:the )?runbook)\b/i,
  /\b(?:network-platform|network platform|change authority|owning team|missing authority|requires? approval)\b/i,
  /\b(?:certificate trust|fingerprint mismatch|trust failure)\b/i,
  /\bno changes (?:were )?(?:needed|required|necessary)\b|\balready (?:configured|correct|compliant|in desired state)\b/i,
];

export function finalResultRequiresEscalation(text) {
  const report = String(text ?? "");
  return BLOCKED_RESULT.test(report)
    && !LEGITIMATE_STOP.some((pattern) => pattern.test(report));
}

export function looksMutatingRemoteCommand(command) {
  const script = String(command ?? "");
  return MUTATION.test(script)
    || OPERATIONAL_MUTATIONS.some((pattern) => pattern.test(script));
}

export function toolFailureRequiresEscalation(result, mutationSeen) {
  if (result?.isError === true) return true;
  if (result?.timedOut === true || result?.transportError === true) return mutationSeen === true;
  return mutationSeen === true
    && Number.isInteger(result?.exitCode)
    && result.exitCode !== 0;
}

export class RoutingState {
  constructor() {
    this.reset();
  }

  reset() {
    this.mode = "auto";
    this.tier = "frontier";
    this.level = "high";
    this.reason = "conservative default";
    this.mutationSeen = false;
    this.escalations = 0;
  }

  route(text) {
    this.mutationSeen = false;
    if (this.mode === "manual") {
      return { tier: this.tier, level: this.level, reason: "manual override", changed: false };
    }
    const decision = classifyPrompt(text, this.level);
    const changed = decision.level !== this.level || decision.tier !== this.tier;
    this.tier = decision.tier ?? this.tier;
    this.level = decision.level;
    this.reason = decision.reason;
    return { ...decision, changed };
  }

  setManual(tier, level) {
    this.mode = "manual";
    this.tier = tier;
    this.level = level;
    this.reason = "manual override";
  }

  setAuto() {
    this.mode = "auto";
    this.reason = "automatic routing restored";
  }

  noteRemoteCommand(command) {
    if (looksMutatingRemoteCommand(command)) this.mutationSeen = true;
  }

  noteRemoteResult(result) {
    if (this.mode !== "auto" || !toolFailureRequiresEscalation(result, this.mutationSeen)) {
      return null;
    }
    const changed = this.level !== "high";
    this.tier = "frontier";
    this.level = "high";
    this.reason = result?.isError === true || result?.timedOut === true || result?.transportError === true
      ? "SSH transport failure"
      : "failed checkpoint after mutation";
    this.escalations += 1;
    return { tier: "frontier", level: "high", reason: this.reason, changed };
  }

  noteFinalResult(text) {
    if (this.mode !== "auto" || this.tier !== "routine" || this.escalations > 0
        || !finalResultRequiresEscalation(text)) {
      return null;
    }
    this.tier = "frontier";
    this.level = "high";
    this.reason = "unexpected bounded-worker stop";
    this.escalations += 1;
    return { tier: this.tier, level: this.level, reason: this.reason, changed: true };
  }
}
