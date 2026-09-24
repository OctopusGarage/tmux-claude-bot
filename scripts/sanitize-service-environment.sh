#!/bin/bash

# Remove ambient credentials inherited from the service manager. Managed bot
# configuration is loaded later from TCB_ENV_FILE.
tcb_sanitize_inherited_environment() {
  local tcb_env_name
  local tcb_env_prefix
  local tcb_restore_nocasematch=0
  local -a tcb_env_names

  if ! shopt -q nocasematch; then
    shopt -s nocasematch
    tcb_restore_nocasematch=1
  fi

  # Enumerate variable names with Bash builtins so credential values are never
  # inherited by a helper subprocess. Prefixes are fixed shell identifiers.
  for tcb_env_prefix in {A..Z} {a..z} _; do
    # Bash 3.2 with nounset treats an empty array as unbound. Keep a sentinel so
    # prefix buckets with no matching variables remain safe to iterate.
    eval 'tcb_env_names=( "__tcb-empty-prefix__" "${!'"$tcb_env_prefix"'@}" )'
    for tcb_env_name in "${tcb_env_names[@]}"; do
      if [ "$tcb_env_name" = "__tcb-empty-prefix__" ]; then
        continue
      fi
      case "_${tcb_env_name}_" in
        *_TOKEN_* | *_SECRET_* | *_PASSWORD_* | *_PASSWD_* | *_CREDENTIAL_* | *_CREDENTIALS_* | *_API_KEY_* | *_ACCESS_KEY_* | *_PRIVATE_KEY_*)
          unset "$tcb_env_name"
          ;;
      esac
    done
  done

  if [ "$tcb_restore_nocasematch" -eq 1 ]; then
    shopt -u nocasematch
  fi
}
