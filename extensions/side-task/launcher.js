import { spawn } from "node:child_process";

const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error("Side conversation launcher did not receive a Pi command.");
  process.exit(2);
}

let finished = false;

function finish(code, detail) {
  if (finished) return;
  finished = true;

  if (code === 0) {
    process.exit(0);
  }

  console.error(`\nSide conversation failed to start (${detail}).`);
  if (!process.stdin.isTTY) {
    process.exit(code);
  }

  console.error("Press Enter to close this floating pane.");
  process.stdin.setRawMode?.(false);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  process.stdin.once("data", () => process.exit(code));
}

const child = spawn(command, args, {
  env: { ...process.env, PI_SIDE_TASK_FLOAT: "1" },
  stdio: "inherit",
});

child.once("error", (error) => finish(127, error.message));
child.once("exit", (code, signal) => {
  finish(code ?? 1, signal ? `signal ${signal}` : `exit ${code ?? 1}`);
});
