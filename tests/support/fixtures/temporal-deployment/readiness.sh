#!/bin/sh
# Owned shell-service readiness used only by the deployment driver fixture.
test -f /tmp/temporal-ready
