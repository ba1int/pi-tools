# Pi tools

Small, user-owned Pi tools for the workstation agent. This repository contains
generic capabilities only; work-specific procedures remain in machine-local
skills.

## SSH Direct

`ssh_exec` executes one Bash program on one explicit SSH destination, while
`ssh_copy` uploads or downloads one explicit regular file. The model supplies
the host on every call, so natural requests can span several machines without
`/ssh`, active-host state, pickers, or session modes.

The tool:

- passes the validated destination as an `ssh` argv item;
- sends the Bash program over stdin rather than embedding it in an SSH command;
- disables forwarding, local commands, TTY allocation, and host-key updates;
- defaults to a 30-second timeout;
- caps rendered output at 16 KiB by default and 32 KiB maximum;
- retains both the beginning and end when output is truncated;
- appends a concise operational view to the remote SSH user's Bash history,
  recording commands by default while omitting duplicates, shell bookkeeping,
  temporary-file mechanics, and likely secret-bearing commands;
- tells Pi to use parallel tool calls for independent hosts; and
- blocks model-generated `ssh`, `scp`, `sftp`, and `rsync` transports through
  local Bash so Pi retries through `ssh_exec` or `ssh_copy` automatically.

`ssh_copy` accepts absolute local and remote paths, rejects globs, traversal,
directories, and local symbolic links, and never places file contents in model
context. Uploads and downloads are SHA-256 verified; downloads land through a
temporary file and are renamed only after verification. The default transfer
limit is 1 GiB (10 GiB maximum) with a 120-second deadline (900 seconds
maximum). A successful upload adds one password-free `scp BASENAME DESTINATION`
entry to the remote SSH user's history; downloads are read-only. For privileged
destinations, upload to a user-writable staging path and use `ssh_exec` for the
final install and validation.

Repeated calls to the same host reuse a secured local OpenSSH control socket
for 60 seconds. This changes transport latency only: commands, results, host
validation, timeouts, and approval behavior remain identical. Set
`PI_SSH_MULTIPLEXING=off` to return to one new connection per call.

History capture happens immediately before each selected command, so failed or
partially applied operations remain visible. Capture is exclusion-based: custom
monitoring scripts and unfamiliar commands are retained without needing to be
known by the extension. Exact duplicate commands within one `ssh_exec` call,
shell bookkeeping and condition tests, temporary mutations, and likely
credential-bearing commands are excluded. File-writing mechanics such as
temporary files, backups, heredocs, `tee`, and atomic `install` are projected as
one `sudoedit PATH` or `vi PATH` entry per durable file; Pi still executes the
original program unchanged. Entries have no Pi-specific comments. Set
`PI_SSH_REMOTE_HISTORY=off` to disable capture. This is shared operator context,
not an audit log: the remote account's Bash history retention and `histappend`
policy still determine how long entries survive.

Failed calls identify DNS, authentication, host-key, refusal, timeout,
connection-loss, and ordinary remote-command exits in compact result metadata.
After mutation, transport failures automatically promote the router to Sol
`high`. During preflight, Luna retains the task until the final result can
distinguish an unexpected connection block from a legitimate topology stop.
An ordinary non-zero read-only command remains at the selected level.

Remote stdout and stderr are stripped of terminal control sequences before
they reach Pi context or the TUI. Printable Unicode, tabs, and newlines remain
unchanged; ANSI cursor/color commands, OSC clipboard or hyperlink writes, DCS
strings, carriage returns, backspaces, and other control bytes are removed.

This is transport and context control, not a remote authorization system. SSH
accounts, sudo policy, and the user's work skills remain the operational
boundaries.

## Incident Investigation

`incident-investigation` supplies a concise evidence contract for alerts and
outages. It separates symptoms from causes, requires discriminating evidence
before claiming root cause, preserves read-only requests, and reports the
smallest safe fix with validation and rollback. Domain skills still define the
actual topology, commands, logs, configuration, and change procedure.

## Thinking Router

`thinking-router` selects the cheapest benchmarked model before each prompt:

- bounded onboarding and explicit runbook execution use Luna `medium`;
- incidents, diagnosis, ambiguity, and runbook engineering use Sol `high`;
- unknown requests conservatively default to Sol `high`;
- short confirmations retain the previous level; and
- an SSH transport error, timeout, or non-zero checkpoint after mutation
  promotes the remaining agent turn to Sol `high`.

If Luna ends a bounded task with an unexpected block, the router switches to
Sol and performs one follow-up pass using the same session context. It does not
retry recognized hard stops such as conflicting network ownership, unsupported
topology, missing change authority, or certificate trust failures. The single
retry bound prevents escalation loops.

The footer status shows the selected mode, model tier, thinking level, and
reason. Shift+Tab or manual model selection creates an override for the current
session. `/think auto` restores automatic routing; `/think luna`, `/think sol`,
and `/think status` are available for debugging. Set `PI_THINKING_ROUTER=off`
for fixed-model benchmarks. Model IDs can be overridden with
`PI_ROUTER_ROUTINE_MODEL` and `PI_ROUTER_FRONTIER_MODEL`.

## Long-running context

`context-sentinel` checkpoints a continuing interactive tool loop through Pi's
native compactor once the active context reaches its configured safe boundary.
The installer applies one version-guarded Pi 0.80.10 runtime patch so the check
runs after a completed tool turn and before the next provider request. Successful
compaction replaces the live next-turn context in place; failure ends the run
before another model call or tool can start. No model-authored yield or hidden
continuation turn is involved.

The extension appends the active task ledger's objective, sparse operator
checkpoints, and a bounded fallback of recent factual tool outcomes to Pi's
native compaction instructions. The fallback is explicitly not treated as proof
that a phase completed; it keeps compaction oriented when the model omitted a
semantic checkpoint. The generated summary is also told to retain authorization,
runbook identity, topology, host-by-host phase, mutations, validation, blockers,
recovery position, approvals, the next safe action, and credentials still needed
by the active authorized operation. Required secret values stay confined to the
compacted context and must not be copied into ledger checkpoints, tool logs,
operator-facing prose, or unrelated artifacts. Set
`PI_CONTEXT_SENTINEL=off` only to disable this ops-specific instruction and
ledger layer; Pi's inline native compaction remains enabled by settings.

## Context budget

GPT-5.6 Sol uses a 272,000-token context window through the `openai-codex`
provider. The installer configures a 68,000-token reserve, so inline automatic
compaction begins just above 204,000 tokens—about 75%—while retaining Pi's
native 20,000-token recent-history window. This leaves enough headroom for a
large tool result and the compaction request itself.

The limit is a plain model override in `config/models.json`; there is no custom
compactor, second summarizer, or orchestration model. The installer merges the
override into machine-local configuration and preserves unrelated providers,
custom models, and per-model options. The runtime patch is exact-version
guarded and idempotent: an unfamiliar Pi build fails installation instead of
silently applying a fuzzy patch.

## Side conversations

`/btw <question>` clones the branch through its latest completed assistant
response into a separate Pi session while leaving the parent session and pane
untouched. It works while the parent is still responding: the active partial
turn is deliberately excluded from the snapshot, matching Codex thread-fork
semantics. `/aside` remains an alias, and `Ctrl+Shift+A` opens a prompt for the
same action. Inside Zellij, Pi
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

## Task ledger

`task-ledger` records Pi's existing lifecycle events into one bounded local
snapshot per Zellij pane. Each Pi process writes only its own atomic file, so
simultaneous agents never share a writer, registry, lock, or daemon. Records
capture the current task, selected model and thinking level, safe tool target,
elapsed time, outcome, cost, and completion state. They never add messages to
model context, call another model, store raw command output, or record hidden
reasoning. Each snapshot retains at most 48 checkpoint rows beneath
`${XDG_STATE_HOME:-~/.local/state}/pi-ledger` with user-only permissions.

For long, multi-host, or materially staged work, the same extension exposes a
small `ops_checkpoint` tool. Before the first mutation it records the exact
acceptance contract, then leaves concise operator-facing field notes when a host
or phase completes, validation changes the known state, work becomes blocked,
rollback position changes, or the plan materially changes. Routine
commands, percentages, unsupported claims, and repeated narration are excluded
by the tool guidance. These notes are bounded separately from mechanical tool
activity, require no slash command or second model, and add only the checkpoint
call itself to the active Pi conversation.

Related conversational follow-ups reopen the same project record, preserving
its bounded notes and factual event tail. An explicit new task, or clearly
unrelated concrete work, starts clean. The displayed focus still follows
substantial pivots: a small local relevance score promotes concrete actions,
hosts, incidents, and ticket-like identifiers while ignoring acknowledgements
and generic prompts such as “continue” or “check again”; it makes no model call.

Run `pi-ledger` to follow the current record. With one Pi pane it opens the
detailed ledger; with several it opens the Protocol Ink agent board. Use
`↑`/`↓` or `j`/`k` to select an agent, `Enter` to jump to its Zellij pane, and
`d` to inspect its field notes and mechanical activity. Finished records leave
the board after 30 minutes, while a dead writer is labeled `STALE`. The workstation dotfiles bind
`Ctrl+o`, then `i` to open the viewer in one floating pane; press `q` to close
it. Floating `/btw` side conversations stay out of the primary board. Set
`PI_TASK_LEDGER=off` to disable recording.

## Install

Node.js 22.19 or newer is required.

```sh
./install.sh
```

The installer pins Pi to `pi-version.txt`, removes every configured third-party
Pi package, retires every other global extension into a timestamped backup,
selects Luna at low thinking, links the measured `ssh-direct` core plus
appearance synchronization and the generic incident skill, installs paired
Protocol Paper/Ink Pi themes that follow the terminal's reported light/dark
appearance, and merges the repository-owned Sol context budget. It preserves
authentication, sessions, unrelated model
configuration, and all other skills.

The default `core` profile is deliberately small. Optional tools remain
available without changing the repository:

```sh
PI_TOOLS_PROFILE=ops ./install.sh   # add /btw and the task ledger
PI_TOOLS_PROFILE=full ./install.sh  # add experimental router + sentinel too
```

`core` is the benchmark-backed workstation default. `ops` adds local interface
features but no model routing. `full` is for experiments and is not the
recommended daily-driver profile.

The repository-owned `study-learn-emit` extension is also preserved when the
separate Study Room package is present, allowing both modular installers to be
rerun without churning extension backups.

The dependency-free `appearance-sync` extension keeps Pi and its containing
Zellij session aligned with macOS while Pi is open. It checks every two seconds
on macOS and every ten seconds in WSL, performs no model calls, and passes Pi a
live theme object so the paired setting remains intact. Ordinary shell prompts
also synchronize Zellij, so no always-running watcher or service is installed.

Restart Pi or run `/reload` after updating the extension.

## Test

```sh
npm test
```
