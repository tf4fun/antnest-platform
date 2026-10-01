# Controller response loss

This note explains where Controller-to-ACP response-loss behavior is tested.

The ACP service no longer exposes `acquire-run` or `finish-run` endpoints to the
Agent Controller; ACP owns Run admission and completion itself. There is
therefore no response-loss scenario for those calls.

The Controller's remaining calls to ACP, `apply-execution-snapshot` and
`settle-agent`, are covered by the [RPC response-loss scenario](../rpc-response-loss/README.md)
(`make e2e-rpc-response-loss`). ACP-side commit-receipt loss is covered by the
[ACP persistence scenario](../acp-persistence/README.md).
