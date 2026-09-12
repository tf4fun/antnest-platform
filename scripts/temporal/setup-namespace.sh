#!/bin/sh
set -eu

if temporal operator namespace describe --namespace antnest >/dev/null 2>&1; then
  exit 0
fi
temporal operator namespace create --namespace antnest --retention 7d
