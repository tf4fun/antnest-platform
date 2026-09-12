ARG RUNTIME_IMAGE=antnest/antnest-runtime:local
FROM ${RUNTIME_IMAGE}
COPY scripts/lifecycle-closeout/update-entrypoint.sh /usr/local/bin/lifecycle-update-entrypoint
ENTRYPOINT ["/bin/sh", "/usr/local/bin/lifecycle-update-entrypoint"]
