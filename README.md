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

## Thinking Router

`thinking-router` changes the current Sol reasoning level before each prompt
without calling another model:

- bounded onboarding and explicit runbook execution use `low`;
- incidents, diagnosis, ambiguity, and runbook engineering use `high`;
- unknown requests conservatively default to `high`;
- short confirmations retain the previous level; and
- an SSH transport error or timeout, or a non-zero checkpoint after mutation,
  promotes the remaining agent turn to `high`.

The footer status shows the selected mode, level, and reason. Shift+Tab creates
a manual override for the current session. `/think auto` restores automatic
routing; `/think low`, `/think high`, and `/think status` are available for
explicit control. Set `PI_THINKING_ROUTER=off` for controlled benchmarks.

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
