export const DEFAULT_TIMEOUT_SECONDS = 30;
export const MAX_TIMEOUT_SECONDS = 120;
export const DEFAULT_OUTPUT_BYTES = 16 * 1024;
export const MAX_OUTPUT_BYTES = 32 * 1024;
export const CONTROL_PERSIST_SECONDS = 60;
export const DEFAULT_TRANSFER_TIMEOUT_SECONDS = 120;
export const MAX_TRANSFER_TIMEOUT_SECONDS = 900;
export const DEFAULT_TRANSFER_BYTES = 1024 * 1024 * 1024;
export const MAX_TRANSFER_BYTES = 10 * 1024 * 1024 * 1024;

const SHELL_DOLLAR = "$";
const REMOTE_HISTORY_PRELUDE = String.raw`__pi_history_file=${SHELL_DOLLAR}{HISTFILE:-"$HOME/.bash_history"}
__pi_history_guard=0
__pi_history_edit_cache='|'
__pi_history_line_cache=''
__pi_history_prefix=''
: >> "$__pi_history_file" 2>/dev/null || true
__pi_history_python_edit() {
  local __pi_edit_cmd="$1" __pi_rest __pi_match __pi_path __pi_paths='' __pi_seen='|'
  local __pi_path_re="['\"](/(etc|home|opt|root|srv|usr|var)/[^'\"[:space:]]+)['\"]"
  local __pi_write_re='(write_text|write_bytes|replace\(|rename\(|unlink\(|shutil\.(copy|move)|os\.(remove|rename|replace|chmod|chown|mkdir|makedirs))'

  [[ $__pi_edit_cmd =~ (^|[;&|][[:space:]]*)(sudo([[:space:]]+-[^[:space:]]+)*[[:space:]]+)?python(3([.][0-9]+)?)?[[:space:]] ]] || return 1
  if [[ -n ${SHELL_DOLLAR}{__pi_history_python_hint:-} ]]; then
    __pi_history_rendered=$__pi_history_python_hint
    __pi_history_python_hint=''
    return 0
  fi
  [[ $__pi_edit_cmd =~ $__pi_write_re ]] || return 1

  __pi_rest=$__pi_edit_cmd
  while [[ $__pi_rest =~ $__pi_path_re ]]; do
    __pi_match=${SHELL_DOLLAR}{BASH_REMATCH[0]}
    __pi_path=${SHELL_DOLLAR}{BASH_REMATCH[1]}
    case $__pi_seen in
      *"|$__pi_path|"*) ;;
      *) __pi_seen="$__pi_seen$__pi_path|"; __pi_paths="$__pi_paths $__pi_path" ;;
    esac
    __pi_rest=${SHELL_DOLLAR}{__pi_rest#*"$__pi_match"}
  done

  # Opaque scripts without literal durable paths are intentionally omitted.
  [[ -n $__pi_paths ]] || { __pi_history_rendered=''; return 0; }
  if [[ $__pi_edit_cmd =~ (^|[;&|][[:space:]]*)sudo([[:space:]]|$) ]]; then
    __pi_history_rendered="sudoedit$__pi_paths"
  else
    __pi_history_rendered="vi$__pi_paths"
  fi
  return 0
}

__pi_history_file_edit() {
  local __pi_edit_cmd="$1" __pi_path='' __pi_plain='' __pi_editor='vi'
  local __pi_tee_re='(^|[;&|][[:space:]]*)(sudo([[:space:]]+-[^[:space:]]+)*[[:space:]]+)?tee([[:space:]]+-[^[:space:]]+)*[[:space:]]+([^[:space:]]+)'
  local __pi_redirect_re='(^|[[:space:]])[0-9]*>>?[[:space:]]*([^&[:space:]]+)'

  if [[ $__pi_edit_cmd =~ $__pi_tee_re ]]; then
    __pi_path=${SHELL_DOLLAR}{BASH_REMATCH[5]}
  elif [[ $__pi_edit_cmd =~ (^|[[:space:]])(sudo[[:space:]]+)?install[[:space:]] ]]; then
    [[ $__pi_edit_cmd =~ (^|[[:space:]])(-d|--directory)([[:space:]]|$) ]] && return 1
    __pi_path=${SHELL_DOLLAR}{__pi_edit_cmd##*[[:space:]]}
  elif [[ $__pi_edit_cmd =~ (^|[[:space:]])(sudo[[:space:]]+)?(cp|mv)[[:space:]] ]]; then
    __pi_path=${SHELL_DOLLAR}{__pi_edit_cmd##*[[:space:]]}
  elif [[ $__pi_edit_cmd =~ (^|[[:space:]])(sudo[[:space:]]+)?(sed|perl)[[:space:]]+-[^[:space:]]*i ]]; then
    __pi_path=${SHELL_DOLLAR}{__pi_edit_cmd##*[[:space:]]}
  elif [[ $__pi_edit_cmd =~ $__pi_redirect_re ]]; then
    __pi_path=${SHELL_DOLLAR}{BASH_REMATCH[2]}
  else
    return 1
  fi

  case $__pi_path in
    \"*\") __pi_plain=${SHELL_DOLLAR}{__pi_path#\"}; __pi_plain=${SHELL_DOLLAR}{__pi_plain%\"} ;;
    \'*\') __pi_plain=${SHELL_DOLLAR}{__pi_path#\'}; __pi_plain=${SHELL_DOLLAR}{__pi_plain%\'} ;;
    *) __pi_plain=$__pi_path ;;
  esac
  case $__pi_plain in
    ''|/dev/null|/dev/stdout|/dev/stderr|/tmp/*|/var/tmp/*|\$B|\$B/*|\$\{B\}|\$\{B\}/*|\$tmp|\$\{tmp\}|\$stage|\$\{stage\}|*'$('*|*.bak|*.bak\"|*.bak\'|*.absent|*.absent\"|*.absent\'|*.tmp|*.tmp\"|*.tmp\'|*.tmp.*|*.tmp.*\"|*.tmp.*\'|*/.*.[0-9][0-9][0-9][0-9]*)
      __pi_history_rendered=''
      return 0
      ;;
  esac

  if [[ $__pi_edit_cmd =~ (^|[;&|][[:space:]]*)sudo([[:space:]]|$) ]]; then
    __pi_editor='sudoedit'
  else
    case $__pi_plain in
      /etc/*|/opt/*|/root/*|/srv/*|/usr/*|/var/*) __pi_editor='sudoedit' ;;
    esac
  fi
  __pi_history_rendered="$__pi_editor $__pi_path"
  return 0
}

__pi_history_record() {
  local __pi_cmd="$1" __pi_head __pi_line __pi_line_key __pi_filter_cmd __pi_secret_safe=0 __pi_record=0 __pi_kind=''
  (( __pi_history_guard == 0 )) || return 0

  __pi_head=${SHELL_DOLLAR}{__pi_cmd%%[[:space:]]*}

  # History is shared operational context, so never persist likely credentials.
  local __pi_secret_re='([Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Pp][Aa][Ss][Ss][Ww][Dd]|[Cc][Hh][Pp][Aa][Ss][Ss][Ww][Dd]|[Tt][Oo][Kk][Ee][Nn]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Aa][Pp][Ii][_-]?[Kk][Ee][Yy]|[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]|[Bb][Ee][Aa][Rr][Ee][Rr]|[Pp][Rr][Ii][Vv][Aa][Tt][Ee][_-]?[Kk][Ee][Yy])'
  case $__pi_cmd in
    getent\ passwd|getent\ passwd\ *|*' /etc/passwd'|*' /etc/passwd '*)
      __pi_secret_safe=1
      ;;
    passwd|passwd\ *|sudo\ passwd|sudo\ passwd\ *|chpasswd|chpasswd\ *|sudo\ chpasswd|sudo\ chpasswd\ *)
      [[ $__pi_cmd == *'<'* || $__pi_cmd == *'>'* || $__pi_cmd == *':'* ]] || __pi_secret_safe=1
      ;;
  esac
  if (( __pi_secret_safe == 0 )) && [[ $__pi_cmd =~ $__pi_secret_re ]]; then
    return 0
  fi
  case $__pi_cmd in
    'grep -q .'|'grep -q . '*|"grep -q '.'"|"grep -q '.' "*) return 0 ;;
  esac

  local __pi_mutation_re='(^|[;&|][[:space:]]*)(sudo([[:space:]]+-[^[:space:]]+)*[[:space:]]+)?(rm|rmdir|mv|cp|install|mkdir|touch|ln|chmod|chown|chgrp|truncate|tee|dd)([[:space:]]|$)|(^|[;&|][[:space:]]*)(sudo([[:space:]]+-[^[:space:]]+)*[[:space:]]+)?(sed|perl)[[:space:]]+-[^[:space:]]*i|(^|[;&|][[:space:]]*)(sudo([[:space:]]+-[^[:space:]]+)*[[:space:]]+)?systemctl[[:space:]]+(daemon-reload|daemon-reexec|restart|reload|stop|start|enable|disable|mask|unmask)([[:space:]]|$)|(^|[;&|][[:space:]]*)(sudo([[:space:]]+-[^[:space:]]+)*[[:space:]]+)?service[[:space:]]+[^[:space:]]+[[:space:]]+(restart|reload|stop|start)([[:space:]]|$)|(^|[;&|][[:space:]]*)(sudo([[:space:]]+-[^[:space:]]+)*[[:space:]]+)?(apt|apt-get|aptitude|dnf|yum|zypper|dpkg|rpm)[[:space:]]+(install|remove|purge|upgrade|full-upgrade|dist-upgrade|update|erase|-i|-U|-e|--install|--remove|--purge|--upgrade|--erase)([[:space:]]|$)|(^|[;&|][[:space:]]*)(sudo([[:space:]]+-[^[:space:]]+)*[[:space:]]+)?(docker|podman)([[:space:]]+compose)?[[:space:]]+(build|create|down|kill|pause|pull|push|restart|rm|rmi|run|start|stop|unpause|update|up)([[:space:]]|$)|(^|[;&|][[:space:]]*)(sudo([[:space:]]+-[^[:space:]]+)*[[:space:]]+)?(kubectl[[:space:]]+(apply|create|delete|drain|edit|label|annotate|patch|replace|rollout|scale|set|taint|cordon|uncordon)|helm[[:space:]]+(install|upgrade|uninstall|rollback))([[:space:]]|$)|(^|[;&|][[:space:]]*)(sudo([[:space:]]+-[^[:space:]]+)*[[:space:]]+)?(useradd|usermod|userdel|groupadd|groupmod|groupdel|passwd|chpasswd|chage|mount|umount|swapon|swapoff|crontab)([[:space:]]|$)|(^|[;&|][[:space:]]*)(sudo([[:space:]]+-[^[:space:]]+)*[[:space:]]+)?(sysctl[[:space:]]+-w|iptables[[:space:]]+(-A|-I|-D|-R|-F|-X|-P|-N)|ip6tables[[:space:]]+(-A|-I|-D|-R|-F|-X|-P|-N)|nft[[:space:]]+(add|delete|insert|replace|flush|reset|import|-f)|ufw[[:space:]]+(enable|disable|allow|deny|reject|limit|delete|reset|reload|route)|firewall-cmd[[:space:]]+--(add|remove|reload|complete-reload|set|new|delete))|(^|[;&|][[:space:]]*)(git[[:space:]]+(add|commit|checkout|switch|merge|rebase|reset|pull|push|restore|clean|cherry-pick|tag)|ansible-playbook)([[:space:]]|$)'
  local __pi_redirect_re='(^|[[:space:]])[0-9]*>>?[[:space:]]*([^&[:space:]]+)'

  # Capture by default. Only discard shell bookkeeping that adds no useful
  # operator context; durable redirects are still treated as file changes.
  case $__pi_head in
    :|true|false|"["|"[["|test|for|while|until|if|then|else|elif|fi|case|esac|select|do|done|function|return|exit|break|continue|shift|wait|trap|set|shopt|umask|local|declare|typeset|readonly|export|unset|read|mapfile|sleep|command|builtin|type|hash|eval|echo|printf)
      if [[ $__pi_cmd =~ $__pi_redirect_re ]]; then
        case ${SHELL_DOLLAR}{BASH_REMATCH[2]} in
          /dev/null|/dev/stdout|/dev/stderr) return 0 ;;
        esac
      else
        return 0
      fi
      ;;
  esac
  [[ $__pi_cmd =~ ^[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*$ ]] && return 0

  # Pipeline consumers without a file operand only describe presentation, not
  # the inspection itself. Keep direct file reads, including absolute paths.
  case $__pi_head in
    head|tail|sort|uniq|column|cut|tr|wc|sed|awk|grep|egrep|fgrep|jq)
      __pi_filter_cmd=${SHELL_DOLLAR}{__pi_cmd%%>*}
      case $__pi_filter_cmd in
        *' /'*|*' ./'*|*' ../'*|*'$HOME/'*|*'${SHELL_DOLLAR}{HOME}/'*|*' ~/'*) ;;
        *) return 0 ;;
      esac
      ;;
  esac

  # A command that cannot resolve on the host is failed fallback noise. This
  # still permits custom functions and executable absolute paths.
  command -v -- "$__pi_head" >/dev/null 2>&1 || return 0

  __pi_history_rendered=''
  __pi_record=1
  __pi_kind='observation'
  if __pi_history_python_edit "$__pi_cmd"; then
    __pi_kind='mutation'
  elif [[ $__pi_head == python || $__pi_head == python3 || $__pi_head == python3.* ]] && [[ $__pi_cmd == *'<<'* ]]; then
    # The one-line heredoc launcher is not replayable. Mutating Python heredocs
    # were already projected above as vi/sudoedit entries.
    return 0
  elif [[ $__pi_cmd =~ $__pi_mutation_re ]]; then
    __pi_kind='mutation'
  elif [[ $__pi_cmd =~ $__pi_redirect_re ]]; then
    case ${SHELL_DOLLAR}{BASH_REMATCH[2]} in
      /dev/null|/dev/stdout|/dev/stderr) ;;
      *) __pi_kind='mutation' ;;
    esac
  fi

  if (( __pi_record == 1 )); then
    if [[ -n $__pi_history_rendered ]]; then
      :
    elif [[ $__pi_kind != mutation ]] || ! __pi_history_file_edit "$__pi_cmd"; then
      if [[ $__pi_kind == mutation && ( $__pi_cmd == *'/tmp/'* || $__pi_cmd == *'/var/tmp/'* || $__pi_cmd == *'$B'* || $__pi_cmd == *'${SHELL_DOLLAR}{B}'* || $__pi_cmd == *'$tmp'* || $__pi_cmd == *'${SHELL_DOLLAR}{tmp}'* || $__pi_cmd == *'$stage'* || $__pi_cmd == *'${SHELL_DOLLAR}{stage}'* || $__pi_cmd == *'/.'*'.'[0-9][0-9][0-9][0-9]* ) ]]; then
        return 0
      fi
      __pi_line=${SHELL_DOLLAR}{__pi_cmd//$'\r'/}
      if [[ $__pi_line == *'<<'* ]]; then
        __pi_line=${SHELL_DOLLAR}{__pi_line%%$'\n'*}
      else
        __pi_line=${SHELL_DOLLAR}{__pi_line//$'\n'/ }
      fi
    fi
    if [[ -n $__pi_history_rendered ]]; then
      case $__pi_history_edit_cache in
        *"|$__pi_history_rendered|"*) return 0 ;;
      esac
      __pi_history_edit_cache="$__pi_history_edit_cache$__pi_history_rendered|"
      __pi_line=$__pi_history_rendered
    elif [[ -z $__pi_line ]]; then
      return 0
    fi
    if [[ $__pi_kind == mutation && -n ${SHELL_DOLLAR}{__pi_history_prefix:-} ]]; then
      case $__pi_line in
        sudo\ *|sudoedit\ *) ;;
        *) __pi_line="$__pi_history_prefix$__pi_line" ;;
      esac
    fi
    [[ -n $__pi_line && ${SHELL_DOLLAR}{#__pi_line} -le 8192 ]] || return 0
    __pi_line_key=$'\n'"$__pi_line"$'\n'
    [[ $'\n'"$__pi_history_line_cache" == *"$__pi_line_key"* ]] && return 0
    __pi_history_line_cache="$__pi_history_line_cache$__pi_line"$'\n'
    __pi_history_guard=1
    printf '%s\n' "$__pi_line" >> "$__pi_history_file" 2>/dev/null || true
    __pi_history_guard=0
  fi
}

__pi_history_source_expansion_safe() {
  local __pi_source_cmd="$1"
  local __pi_safe_re='(^|[;&|][[:space:]]*)(sudo([[:space:]]+-[^[:space:]]+)*[[:space:]]+)?(rm|rmdir|mv|cp|install|mkdir|touch|ln|chmod|chown|chgrp|truncate|groupadd|groupmod|groupdel|useradd|usermod|userdel|chage|getent|id|stat|systemctl|service)([[:space:]]|$)'
  [[ $__pi_source_cmd =~ $__pi_safe_re ]] || return 1
  [[ $__pi_source_cmd == *chpasswd* ]] && return 1
  if [[ $__pi_source_cmd =~ (^|[[:space:]])(useradd|usermod)([[:space:]].*)?[[:space:]](-p|--password)([=[:space:]]|$) ]]; then
    return 1
  fi
  return 0
}

__pi_history_normalize_executable() {
  local __pi_exec_cmd="$1"
  local __pi_exec_re='^(sudo([[:space:]]+-[^[:space:]]+)*[[:space:]]+)?(/[^[:space:]]*/)?(rm|rmdir|mv|cp|install|mkdir|touch|ln|chmod|chown|chgrp|truncate|groupadd|groupmod|groupdel|useradd|usermod|userdel|passwd|chpasswd|chage|getent|id|stat|systemctl|service)([[:space:]].*)?$'
  __pi_history_normalized=$__pi_exec_cmd
  if [[ $__pi_exec_cmd =~ $__pi_exec_re ]]; then
    __pi_history_normalized="${SHELL_DOLLAR}{BASH_REMATCH[1]}${SHELL_DOLLAR}{BASH_REMATCH[4]}${SHELL_DOLLAR}{BASH_REMATCH[5]}"
  fi
}

__pi_history_trace_filter() {
  local __pi_trace __pi_source __pi_expanded __pi_candidate __pi_vars __pi_var __pi_unsafe
  while IFS= read -r __pi_trace; do
    case $__pi_trace in
      *'+PI_SRC='*'|PI_EXP= '*) ;;
      *) continue ;;
    esac
    __pi_source=${SHELL_DOLLAR}{__pi_trace#*+PI_SRC=}
    __pi_expanded=${SHELL_DOLLAR}{__pi_source#*|PI_EXP= }
    __pi_source=${SHELL_DOLLAR}{__pi_source%%|PI_EXP= *}
    case $__pi_expanded in
      __pi_src=*|__pi_history_*) continue ;;
    esac

    __pi_history_normalize_executable "$__pi_expanded"
    __pi_candidate=$__pi_history_normalized
    __pi_unsafe=0
    __pi_vars=$__pi_source
    if [[ $__pi_vars == *'$('* ]]; then
      __pi_unsafe=1
    elif [[ $__pi_candidate == chpasswd || $__pi_candidate == sudo\ chpasswd ]]; then
      :
    elif ! __pi_history_source_expansion_safe "$__pi_source" && ! __pi_history_source_expansion_safe "$__pi_candidate"; then
      while [[ $__pi_vars =~ \$\{?([A-Za-z_][A-Za-z0-9_]*)\}? ]]; do
        __pi_var=${SHELL_DOLLAR}{BASH_REMATCH[1]}
        case $__pi_var in
          n|u|g|user|username|group|host|hostname|service|unit|name|path|file|dir|src|tmp|stage|staging|dst|dest|target|package|version|port|HOME|SUDO_USER) ;;
          *) __pi_unsafe=1 ;;
        esac
        __pi_vars=${SHELL_DOLLAR}{__pi_vars#*"${SHELL_DOLLAR}{BASH_REMATCH[0]}"}
      done
    fi
    (( __pi_unsafe == 0 )) || continue
    if [[ $__pi_source == *'>'* ]]; then
      case $__pi_source in
        *'> /dev/null'*|*'>/dev/null'*|*'> /dev/stdout'*|*'> /dev/stderr'*) ;;
        *'$'*) continue ;;
        *) __pi_candidate=$__pi_source ;;
      esac
    fi
    __pi_history_record "$__pi_candidate"
  done
}

__pi_history_finish() {
  local __pi_status=${SHELL_DOLLAR}{1:-0}
  set +x
  trap - DEBUG EXIT
  if [[ ${SHELL_DOLLAR}{BASH_XTRACEFD:-} == 19 ]]; then
    unset BASH_XTRACEFD
    exec 19>&-
    [[ -z ${SHELL_DOLLAR}{__pi_history_trace_pid:-} ]] || wait "$__pi_history_trace_pid" 2>/dev/null || true
  fi
  return "$__pi_status"
}

__pi_history_start() {
  if (( BASH_VERSINFO[0] < 4 )); then
    trap '__pi_history_record "$BASH_COMMAND"' DEBUG
    return 0
  fi
  exec 19> >(__pi_history_trace_filter)
  __pi_history_trace_pid=$!
  BASH_XTRACEFD=19
  __pi_src=''
  trap '__pi_src=$BASH_COMMAND' DEBUG
  PS4='+PI_SRC=${SHELL_DOLLAR}{__pi_src}|PI_EXP= '
  trap '__pi_history_status=$?; __pi_history_finish "$__pi_history_status"; exit "$__pi_history_status"' EXIT
  set -x
}
`;

const HOST_PATTERN = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,252}|[A-Za-z0-9][A-Za-z0-9._-]{0,63}@[A-Za-z0-9][A-Za-z0-9._-]{0,252})$/;

const TRANSPORT_FAILURE_KINDS = new Set([
  "timeout",
  "dns",
  "authentication",
  "host_key",
  "connection_refused",
  "connection_timeout",
  "connection_closed",
]);

export function validateHost(value) {
  if (typeof value !== "string" || !HOST_PATTERN.test(value)) {
    throw new Error(
      "host must be one literal SSH alias or hostname using only letters, digits, dot, underscore, dash, and optional user@host",
    );
  }
  return value;
}

export function validateCommand(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("command must be a non-empty Bash program");
  }
  if (value.includes("\0")) {
    throw new Error("command cannot contain a NUL byte");
  }
  return value;
}

export function validateLocalPath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0") || /[\r\n]/.test(value)) {
    throw new Error("local_path must be one absolute local path without NUL or newline bytes");
  }
  return value;
}

export function validateRemotePath(value) {
  if (typeof value !== "string" || !/^\/(?:[A-Za-z0-9._+@%=-]+\/?)*$/.test(value)) {
    throw new Error("remote_path must be one absolute path using only letters, digits, slash, dot, underscore, plus, at, percent, equals, and dash");
  }
  if (value.split("/").includes("..")) throw new Error("remote_path cannot contain parent traversal");
  return value;
}

export function normalizeTimeout(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_SECONDS) {
    throw new Error(`timeout_seconds must be an integer from 1 to ${MAX_TIMEOUT_SECONDS}`);
  }
  return value;
}

export function normalizeOutputLimit(value) {
  if (value === undefined) return DEFAULT_OUTPUT_BYTES;
  if (!Number.isInteger(value) || value < 1024 || value > MAX_OUTPUT_BYTES) {
    throw new Error(`max_output_bytes must be an integer from 1024 to ${MAX_OUTPUT_BYTES}`);
  }
  return value;
}

export function normalizeTransferTimeout(value) {
  if (value === undefined) return DEFAULT_TRANSFER_TIMEOUT_SECONDS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TRANSFER_TIMEOUT_SECONDS) {
    throw new Error(`timeout_seconds must be an integer from 1 to ${MAX_TRANSFER_TIMEOUT_SECONDS}`);
  }
  return value;
}

export function normalizeTransferLimit(value) {
  if (value === undefined) return DEFAULT_TRANSFER_BYTES;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TRANSFER_BYTES) {
    throw new Error(`max_bytes must be an integer from 1 to ${MAX_TRANSFER_BYTES}`);
  }
  return value;
}

export function connectionReuseEnabled(value) {
  return !/^(?:0|off|false)$/i.test(String(value ?? ""));
}

export function remoteHistoryEnabled(value) {
  return !/^(?:0|off|false)$/i.test(String(value ?? ""));
}

export function classifySshFailure({ exitCode, stderr = "", timedOut = false }) {
  if (timedOut) return "timeout";
  if (exitCode === 0) return null;
  if (exitCode !== 255) return "remote_exit";

  const message = String(stderr);
  if (/Could not resolve hostname|Name or service not known|nodename nor servname provided|Temporary failure in name resolution/i.test(message)) {
    return "dns";
  }
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|No .* host key is known|Offending .* key/i.test(message)) {
    return "host_key";
  }
  if (/(?:^|\n)(?:[^:\n]+@[^:\n]+:\s*)?Permission denied \([^)]+\)\.?/i.test(message)
      || /Authentication failed|Too many authentication failures|No supported authentication methods available/i.test(message)) {
    return "authentication";
  }
  if (/Connection refused/i.test(message)) return "connection_refused";
  if (/Connection timed out|Operation timed out|connect to host .* port .*: timed out/i.test(message)) {
    return "connection_timeout";
  }
  if (/Connection (?:closed|reset)|kex_exchange_identification|banner exchange|Broken pipe|closed by remote host/i.test(message)) {
    return "connection_closed";
  }
  return "remote_exit";
}

export function isTransportFailureKind(kind) {
  return TRANSPORT_FAILURE_KINDS.has(kind);
}

function consumeCsi(value, index) {
  while (index < value.length) {
    const code = value.charCodeAt(index);
    index += 1;
    if (code >= 0x40 && code <= 0x7e) break;
  }
  return index;
}

function consumeControlString(value, index) {
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === 0x07 || code === 0x9c) return index + 1;
    if (code === 0x1b && value.charCodeAt(index + 1) === 0x5c) return index + 2;
    index += 1;
  }
  return index;
}

export function sanitizeTerminalText(value) {
  const input = String(value ?? "");
  let output = "";

  for (let index = 0; index < input.length;) {
    const code = input.charCodeAt(index);
    if (code === 0x1b) {
      const next = input.charCodeAt(index + 1);
      if (next === 0x5b) {
        index = consumeCsi(input, index + 2);
      } else if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
        index = consumeControlString(input, index + 2);
      } else if ([0x28, 0x29, 0x2a, 0x2b, 0x2d, 0x2e, 0x2f].includes(next)) {
        index = Math.min(input.length, index + 3);
      } else {
        index = Math.min(input.length, index + 2);
      }
      continue;
    }
    if (code === 0x9b) {
      index = consumeCsi(input, index + 1);
      continue;
    }
    if (code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      index = consumeControlString(input, index + 1);
      continue;
    }
    if (code === 0x0a || code === 0x09) {
      output += input[index];
    } else if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) {
      output += input[index];
    }
    index += 1;
  }

  return output;
}

export function sshArgs(host, { controlPath } = {}) {
  const args = [
    "-T",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ClearAllForwardings=yes",
    "-o", "ForwardAgent=no",
    "-o", "ForwardX11=no",
    "-o", "PermitLocalCommand=no",
    "-o", "RequestTTY=no",
    "-o", "UpdateHostKeys=no",
  ];
  if (controlPath !== undefined) {
    if (typeof controlPath !== "string" || controlPath.length === 0 || controlPath.includes("\0")) {
      throw new Error("controlPath must be a non-empty local path without NUL bytes");
    }
    args.push(
      "-o", "ControlMaster=auto",
      "-o", `ControlPersist=${CONTROL_PERSIST_SECONDS}`,
      "-o", `ControlPath=${controlPath}`,
    );
  }
  args.push("--", validateHost(host), "exec bash -se");
  return args;
}

function transportOptions(controlPath) {
  const args = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ClearAllForwardings=yes",
    "-o", "ForwardAgent=no",
    "-o", "ForwardX11=no",
    "-o", "PermitLocalCommand=no",
    "-o", "RequestTTY=no",
    "-o", "UpdateHostKeys=no",
  ];
  if (controlPath !== undefined) {
    if (typeof controlPath !== "string" || controlPath.length === 0 || controlPath.includes("\0")) {
      throw new Error("controlPath must be a non-empty local path without NUL bytes");
    }
    args.push(
      "-o", "ControlMaster=auto",
      "-o", `ControlPersist=${CONTROL_PERSIST_SECONDS}`,
      "-o", `ControlPath=${controlPath}`,
    );
  }
  return args;
}

export function scpArgs(host, direction, localPath, remotePath, { controlPath } = {}) {
  const validatedHost = validateHost(host);
  const validatedLocal = validateLocalPath(localPath);
  const validatedRemote = validateRemotePath(remotePath);
  if (!new Set(["upload", "download"]).has(direction)) {
    throw new Error("direction must be upload or download");
  }
  const remote = `${validatedHost}:${validatedRemote}`;
  const operands = direction === "upload"
    ? [validatedLocal, remote]
    : [remote, validatedLocal];
  return ["-B", "-q", ...transportOptions(controlPath), ...operands];
}

export function remoteProgram(command, { recordHistory = true } = {}) {
  const prelude = recordHistory ? REMOTE_HISTORY_PRELUDE : "";
  const validated = validateCommand(command);
  const pythonHint = recordHistory ? inferPythonHistoryEdit(validated) : "";
  const hintPrelude = pythonHint
    ? `__pi_history_python_hint=${shellSingleQuote(pythonHint)}\n`
    : "";
  const executable = recordHistory ? instrumentNestedBashHeredocs(validated) : validated;
  const historyStart = recordHistory ? "__pi_history_start || true\n" : "";
  return `${prelude}${hintPrelude}set -o pipefail\n${historyStart}${executable}\n`;
}

function nestedHistoryPrelude({ privileged }) {
  if (!privileged) return `${REMOTE_HISTORY_PRELUDE}__pi_history_start || true`;
  const nestedHeader = String.raw`__pi_history_owner=${SHELL_DOLLAR}{SUDO_USER:-${SHELL_DOLLAR}(id -un)}
__pi_history_home=${SHELL_DOLLAR}(getent passwd "$__pi_history_owner" 2>/dev/null | cut -d: -f6)
[[ -n $__pi_history_home ]] || __pi_history_home=$HOME
__pi_history_file="$__pi_history_home/.bash_history"
`;
  const prelude = REMOTE_HISTORY_PRELUDE.replace(/^__pi_history_file=.*\n/, nestedHeader);
  return `${prelude}__pi_history_prefix='sudo '\n__pi_history_start || true`;
}

function instrumentNestedBashHeredocs(command) {
  const lines = command.split("\n");
  const output = [];
  const launcher = /^(\s*)(sudo(?:\s+-\S+)*\s+)?(?:\/usr\/bin\/|\/bin\/)?bash(?:\s+[^<\n]*)?\s+<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\3\s*$/;
  for (const line of lines) {
    output.push(line);
    const match = line.match(launcher);
    if (!match) continue;
    output.push(nestedHistoryPrelude({ privileged: Boolean(match[2]) }));
  }
  return output.join("\n");
}

export function shellSingleQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function remoteFileMetadataCommand(remotePath) {
  const path = shellSingleQuote(validateRemotePath(remotePath));
  return `set -e\nsize=$(stat -Lc %s -- ${path})\nsha=$(sha256sum -- ${path} | awk '{print $1}')\nprintf 'size=%s\\nsha256=%s\\n' "$size" "$sha"`;
}

export function remoteTransferHistoryCommand(localPath, remotePath) {
  const source = validateLocalPath(localPath).split("/").at(-1) || "file";
  const destination = validateRemotePath(remotePath);
  const line = `scp ${source} ${destination}`;
  if (/(?:password|passwd|token|secret|api[_-]?key|authorization|bearer|private[_-]?key)/i.test(line)) {
    return "";
  }
  return `hist=\${HISTFILE:-\"$HOME/.bash_history\"}\nprintf '%s\\n' ${shellSingleQuote(line)} >> "$hist"`;
}

function inferPythonHistoryEdit(command) {
  if (!/(?:^|[;&|]\s*)(?:sudo(?:\s+-\S+)*\s+)?python(?:3(?:\.\d+)?)?\s/m.test(command)) return "";
  if (!/(?:write_text|write_bytes|replace\(|rename\(|unlink\(|shutil\.(?:copy|move)|os\.(?:remove|rename|replace|chmod|chown|mkdir|makedirs))/.test(command)) return "";
  if (/(?:password|passwd|chpasswd|token|secret|api[_-]?key|authorization|bearer|private[_-]?key)/i.test(command)) return "";

  const paths = [];
  const seen = new Set();
  const literalPath = /(['"])(\/(?:etc|home|opt|root|srv|usr|var)\/[^'"\s]+)\1/g;
  for (const match of command.matchAll(literalPath)) {
    const path = match[2];
    if (/\.(?:bak|absent)$/.test(path) || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  if (paths.length === 0) return "";
  const editor = /(?:^|[;&|]\s*)sudo(?:\s+-\S+)*\s+python/m.test(command) ? "sudoedit" : "vi";
  return `${editor} ${paths.join(" ")}`;
}

export function looksLikeRawRemoteTransport(command) {
  if (typeof command !== "string") return false;
  const segments = command.split(/[\n;&|()]+/);
  return segments.some((segment) => {
    const normalized = segment.trim().replace(/^(?:command\s+|exec\s+|sudo(?:\s+-\S+)*\s+|env(?:\s+\S+=\S+)*\s+)+/, "");
    return /^(?:ssh|scp|sftp)(?:\s|$)/.test(normalized)
      || /^rsync(?:\s|$).*\S:/.test(normalized);
  });
}

export class BoundedCapture {
  constructor(limit) {
    this.limit = normalizeOutputLimit(limit);
    this.totalBytes = 0;
    this.overflow = false;
    this.full = [];
    this.head = Buffer.alloc(0);
    this.tail = Buffer.alloc(0);
    this.headLimit = Math.floor(this.limit * 0.6);
    this.tailLimit = this.limit - this.headLimit;
  }

  push(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.totalBytes += bytes.length;

    if (!this.overflow) {
      this.full.push(bytes);
      const buffered = this.full.reduce((sum, item) => sum + item.length, 0);
      if (buffered <= this.limit) return;

      const combined = Buffer.concat(this.full);
      this.head = combined.subarray(0, this.headLimit);
      this.tail = combined.subarray(combined.length - this.tailLimit);
      this.full = [];
      this.overflow = true;
      return;
    }

    this.tail = Buffer.concat([this.tail, bytes]).subarray(-this.tailLimit);
  }

  storedBytes() {
    if (!this.overflow) return this.full.reduce((sum, item) => sum + item.length, 0);
    return this.head.length + this.tail.length;
  }

  text() {
    if (!this.overflow) return Buffer.concat(this.full).toString("utf8");
    const omitted = Math.max(0, this.totalBytes - this.head.length - this.tail.length);
    return `${this.head.toString("utf8")}\n\n... stream truncated (${omitted} bytes omitted) ...\n\n${this.tail.toString("utf8")}`;
  }
}

function safeUtf8Slice(buffer, start, end) {
  return buffer.subarray(start, end).toString("utf8");
}

export function truncateOutput(text, maxBytes) {
  const limit = normalizeOutputLimit(maxBytes);
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) {
    return { text, truncated: false, originalBytes: bytes.length };
  }

  const marker = `\n\n... output truncated (${bytes.length - limit}+ bytes omitted) ...\n\n`;
  const markerBytes = Buffer.byteLength(marker);
  const contentBudget = Math.max(0, limit - markerBytes);
  const headBytes = Math.floor(contentBudget * 0.6);
  const tailBytes = contentBudget - headBytes;
  const head = safeUtf8Slice(bytes, 0, headBytes);
  const tail = safeUtf8Slice(bytes, bytes.length - tailBytes);
  return {
    text: `${head}${marker}${tail}`,
    truncated: true,
    originalBytes: bytes.length,
  };
}

export function formatResult({ host, exitCode, stdout, stderr, elapsedMs, maxOutputBytes, timedOut, failureKind }) {
  const safeStdout = sanitizeTerminalText(stdout);
  const safeStderr = sanitizeTerminalText(stderr);
  const sections = [
    `host: ${host}`,
    `exit: ${exitCode === null ? "none" : exitCode}`,
  ];
  if (failureKind) sections.push(`failure_kind: ${failureKind}`);
  sections.push(`elapsed_ms: ${elapsedMs}`);
  if (timedOut) sections.push("timed_out: true");
  if (safeStdout) sections.push(`\nstdout:\n${safeStdout}`);
  if (safeStderr) sections.push(`\nstderr:\n${safeStderr}`);
  const result = truncateOutput(sections.join("\n"), maxOutputBytes);
  if (result.truncated) {
    result.text += `\ntruncated: true\noriginal_bytes: ${result.originalBytes}`;
  }
  return result;
}
