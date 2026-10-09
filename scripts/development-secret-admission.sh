#!/bin/sh
set -eu

case "${ANTNEST_ALLOW_PUBLIC_DEV_SECRETS-}" in
  ''|false|true) ;;
  *)
    printf '%s\n' 'ANTNEST_ALLOW_PUBLIC_DEV_SECRETS must be exactly true or false' >&2
    exit 1
    ;;
esac

warned=
for variable do
  case "$variable" in
    ''|[!a-zA-Z_]*|*[!a-zA-Z0-9_]*)
      printf '%s\n' 'development secret admission: invalid variable name' >&2
      exit 1
      ;;
  esac
  # Names are validated above; values are expanded once, never evaluated as code.
  eval 'value=${'"$variable"'-}'
  case "$value" in
    "antnest-postgres-dev"|\
    "antnest-egress-dev"|\
    "antnest-runtime-controller-dev"|\
    "antnest-agent-acp-dev"|\
    "antnest-identity-dev"|\
    "antnest-agent-controller-dev"|\
    "antnest-skill-registry-dev"|\
    "antnest-temporal-dev"|\
    "antnest-admin-dev"|\
    "antnest-skill-registry-local-development-token")
      if [ "${ANTNEST_ALLOW_PUBLIC_DEV_SECRETS-}" != true ]; then
        printf '%s uses a published development value\n' "$variable" >&2
        exit 1
      fi
      case " $warned " in
        *" $variable "*) ;;
        *)
          printf 'WARN Published development secret explicitly enabled: %s\n' "$variable" >&2
          warned="$warned $variable"
          ;;
      esac
      ;;
  esac
done
