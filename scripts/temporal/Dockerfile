FROM temporalio/admin-tools:1.31.0 AS tools
FROM temporalio/server:1.31.0
COPY --from=tools /usr/local/bin/tdbg /usr/local/bin/tdbg
COPY --chmod=0555 scripts/temporal/readiness.sh /etc/temporal/readiness.sh
