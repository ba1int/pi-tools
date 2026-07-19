# Pi tools

Small, user-owned Pi tools for the workstation agent. This repository contains
generic capabilities only; work-specific procedures remain in machine-local
skills.

## SSH Direct

`ssh_exec` executes one Bash program on one explicit SSH destination. The model
supplies the host on every call, so natural requests can span several machines
without `/ssh`, active-host state, pickers, or session modes.

The tool:

- passes the validated destination as an `ssh` argv item;
- sends the Bash program over stdin rather than embedding it in an SSH command;
- disables forwarding, local commands, TTY allocation, and host-key updates;
- defaults to a 30-second timeout;
- caps rendered output at 16 KiB by default and 32 KiB maximum;
- retains both the beginning and end when output is truncated;
- tells Pi to use parallel tool calls for independent hosts; and
- blocks model-generated `ssh`, `scp`, `sftp`, and `rsync` transports through
  local Bash so Pi retries through `ssh_exec` automatically.

This is transport and context control, not a remote authorization system. SSH
accounts, sudo policy, and the user's work skills remain the operational
boundaries.

## Incident Investigation

`incident-investigation` supplies a concise evidence contract for alerts and
outages. It separates symptoms from causes, requires discriminating evidence
before claiming root cause, preserves read-only requests, and reports the
smallest safe fix with validation and rollback. Domain skills still define the
actual topology, commands, logs, configuration, and change procedure.

## Side conversations

`/btw <question>` clones the completed active branch into a separate Pi session
while leaving the parent session and pane untouched. `/aside` remains an alias,
and `Ctrl+Shift+A` opens a prompt for the same action. Inside Zellij, Pi
automatically opens the child in a focused 85% floating pane; exiting that Pi
process closes the float and reveals the untouched parent. Outside Zellij, or
if pane creation fails, Pi displays a shell-safe `pi --session ...` fallback
command.

For provider payloads that expose Pi's `prompt_cache_key`, the child reuses the
recorded parent session ID as its cache-routing key while retaining its own Pi
session identity and file. This lets an identical inherited prefix address the
parent's provider cache instead of losing affinity merely because the clone has
a new session ID.

The child records the parent session ID and file, the exact origin entry, the
question, and a read-only policy. A visible boundary tells the model to treat
the inherited history as reference context instead of unfinished instructions.
While that metadata is active, the extension blocks every model tool except
`read`, `grep`, `find`, and `ls`, and handles `!` shell commands without running
them. `/aside-return` switches the current pane back to the recorded parent;
in an automatically opened Zellij float it closes the float instead, revealing
the parent that is already open underneath.

This is a Pi policy boundary, not filesystem or process isolation. Unknown
custom tools are blocked, but arbitrary third-party extension commands and
other processes are outside the guard. The MVP deliberately does not merge
histories or write conclusions into a concurrently open parent session; copy a
compact conclusion back explicitly when desired.

Side sessions refuse Pi's RPC mode. Pi `0.80.10` routes the direct RPC `bash`
command outside the interactive `user_bash` extension hook, so allowing RPC
would weaken the stated default. Opening a recorded side session in RPC mode
therefore exits immediately with status 2. Normal interactive TUI use and
model-driven read-only tools remain supported.

The clone preserves the inherited message prefix plus recorded model and
thinking changes. The extension adds its boundary only after that prefix and
does not alter active tool definitions, which is friendly to provider prompt
caches. Reuse remains best-effort: new turns still consume tokens, and changes
to the model, system prompt, tool definitions, provider behavior, or retention
window can invalidate cached work. `PI_CACHE_RETENTION=long` requests longer
retention only where the selected provider supports it. Pi's footer reports
cache read (`R`), write (`W`), and hit (`CH`) metrics.

## Install

Node.js 22.19 or newer is required.

```sh
./install.sh
```

The installer pins Pi to `pi-version.txt`, removes every configured third-party
Pi package, retires every other global extension into a timestamped backup,
links the repository-owned extensions and generic incident skill, and installs
the Protocol Ink Pi theme. It preserves authentication, sessions, models, and
all other skills.

Restart Pi or run `/reload` after updating the extension.

## Test

```sh
npm test
```
