# Retired Run Admission Contract

The Controller Run admission API has been removed during the execution-boundary
refactor. `resolve-agent-access`, `get-session-configuration`, `acquire-run`,
`resolve-credential` and `finish-run` are no longer registered. There is no
fallback, compatibility mode or per-Run Controller permit.

Agent default authorization and the workspace Agent list remain management
operations in [control-api.md](control-api.md) and
[control-contract.json](control-contract.json). The old Run machine contract is
removed. ACP receives current configuration through management RPC and owns
protocol authorization, Session/Run state, model/Tool execution and audit.

Controller's legacy workspace execution reader and Run persistence are also removed.
This does not mean the whole platform has switched: Gateway, Console and deployment
acceptance remain B3-B5. See the
[implementation plan](../../docs/controller-acp-execution-boundary-plan.md#102-当前实施进度).
