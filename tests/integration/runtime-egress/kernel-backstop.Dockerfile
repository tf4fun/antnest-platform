ARG EGRESS_TEST_BUILD_IMAGE
ARG EGRESS_TEST_PRODUCTION_IMAGE
FROM ${EGRESS_TEST_BUILD_IMAGE} AS tests
FROM ${EGRESS_TEST_PRODUCTION_IMAGE}
COPY --from=tests /tmp/kernel-backstop-test /usr/local/bin/kernel-backstop-test
ENTRYPOINT ["/usr/local/bin/kernel-backstop-test", "--ignored", "--nocapture", "--test-threads=1"]
