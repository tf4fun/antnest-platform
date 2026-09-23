# Shared by disposable ACP integration profiles only.
wait_for_health() {
  attempt=0
  while [ "$attempt" -lt 60 ]; do
    health=$(docker_cmd inspect --format '{{.State.Health.Status}}' "$1") || return $?
    [ "$health" != healthy ] || return 0
    attempt=$((attempt + 1))
    sleep 1
  done
  echo "ACP restart health did not converge" >&2
  return 1
}

client_state() {
  state=$(docker_cmd inspect --format '{{.State.Status}}:{{.State.ExitCode}}' "$1") || return $?
  case "$state" in
    running:*) printf '%s\n' running ;;
    exited:*)
      case "${state#exited:}" in
        ''|*[!0-9]*) return 1 ;;
        *) printf '%s\n' "$state" ;;
      esac ;;
    *) echo "Unexpected client container state" >&2; return 1 ;;
  esac
}
