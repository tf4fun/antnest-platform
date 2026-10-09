FROM temporalio/admin-tools:1.32.0 AS tools
FROM temporalio/server:1.32.0 AS server
FROM server
COPY --from=tools /usr/local/bin/tdbg /usr/local/bin/tdbg
COPY --from=server --chmod=0555 /etc/temporal/entrypoint.sh /etc/temporal/entrypoint-upstream.sh
COPY --chmod=0555 scripts/development-secret-admission.sh /etc/temporal/development-secret-admission.sh
COPY --chmod=0555 scripts/temporal/entrypoint.sh /etc/temporal/entrypoint.sh
COPY --chmod=0555 scripts/temporal/readiness.sh /etc/temporal/readiness.sh
