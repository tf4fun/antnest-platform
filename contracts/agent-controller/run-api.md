# Retired Run Admission Contract

This document records that Agent Controller no longer provides a Run admission
API and points to the contracts that replace it.

The Controller Run admission routes `resolve-agent-access`,
`get-session-configuration`, `acquire-run`, `resolve-credential` and
`finish-run` are not registered. There is no fallback, compatibility mode or
per-Run Controller permit.

Agent default authorization and the workspace Agent list remain management
operations in [control-api.md](control-api.md) and
[control-contract.json](control-contract.json). ACP receives current
configuration through management RPC and owns protocol authorization,
Session/Run state, model/Tool execution and audit; see the
[ACP execution API](../agent-acp/execution-api.md).

Controller has no workspace execution reader and no Run persistence. Gateway
reads workspace execution state from ACP, and Admin Console reads execution
audit history from ACP.
