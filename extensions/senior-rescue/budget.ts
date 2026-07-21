import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function limit() {
  const value = Number(process.env.PI_SENIOR_MAX_TOOL_CALLS ?? "6");
  return Number.isInteger(value) && value >= 1 && value <= 12 ? value : 6;
}

export default function seniorBudget(pi: ExtensionAPI) {
  let calls = 0;
  const maximum = limit();

  pi.on("tool_call", async () => {
    calls += 1;
    if (calls <= maximum) return;
    return {
      block: true,
      reason: `Senior rescue tool budget exhausted (${maximum}). Stop investigating and return the structured handback now.`,
    };
  });

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\nYou are inside a bounded senior rescue lease. You have at most ${maximum} tool calls. Do not delegate, broaden scope, or start unrelated work.`,
  }));
}
