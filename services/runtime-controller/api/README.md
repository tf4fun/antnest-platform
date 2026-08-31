# Runtime Controller API

This directory is owned and versioned by Runtime Controller. It contains the
complete internal JSON-over-HTTP contract consumed by Agent Controller:

- `control-api.md`: lifecycle and recovery semantics;
- `control-contract.json`: machine-readable routes, headers, errors, and
  response mappings;
- `control-api.schema.json`: request and response JSON schemas;
- `runtime-deployment.schema.json`: complete Runtime configuration accepted
  from Agent Controller; physical platform identity remains private.

The service's contract tests read these files directly from this Go module.
Repository-level contract catalogs may link here, but must not copy or redefine
the schemas.
