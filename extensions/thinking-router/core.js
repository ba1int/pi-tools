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
    return { level: "high", reason: "investigation or runbook engineering", retained: false };
  }
  if (ROUTINE_SIGNALS.some((pattern) => pattern.test(prompt))) {
    return { level: "low", reason: "bounded routine operation", retained: false };
  }
  return { level: "high", reason: "conservative default", retained: false };
}

export function looksMutatingRemoteCommand(command) {
  const script = String(command ?? "");
  return MUTATION.test(script)
    || OPERATIONAL_MUTATIONS.some((pattern) => pattern.test(script));
}

export function toolFailureRequiresEscalation(result, mutationSeen) {
  if (result?.isError === true || result?.timedOut === true || result?.transportError === true) return true;
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
    this.level = "high";
    this.reason = "conservative default";
    this.mutationSeen = false;
  }

  route(text) {
    this.mutationSeen = false;
    if (this.mode === "manual") {
      return { level: this.level, reason: "manual override", changed: false };
    }
    const decision = classifyPrompt(text, this.level);
    const changed = decision.level !== this.level;
    this.level = decision.level;
    this.reason = decision.reason;
    return { ...decision, changed };
  }

  setManual(level) {
    this.mode = "manual";
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
    this.level = "high";
    this.reason = result?.isError === true || result?.timedOut === true || result?.transportError === true
      ? "SSH transport failure"
      : "failed checkpoint after mutation";
    return { level: "high", reason: this.reason, changed };
  }
}
