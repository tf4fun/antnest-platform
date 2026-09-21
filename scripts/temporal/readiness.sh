#!/bin/sh
set -eu

# WorkflowService is gated by frontend membership initialization in 1.31.0.
# Neither this read nor the gossip queries requires an application namespace.
wget -q -T 2 -O /dev/null http://127.0.0.1:7243/api/v1/system-info
for role in frontend history matching; do
  members=$(tdbg --address 127.0.0.1:7233 --context-timeout 2 membership list-gossip --role "$role")
  # tdbg's role-filtered output has one integer member_count. Fail closed if
  # absent, zero or malformed; never use list-db's persisted heartbeat rows.
  printf '%s\n' "$members" | grep -Eq '^[[:space:]]*"member_count":[[:space:]]*[1-9][0-9]*,[[:space:]]*$'
done
