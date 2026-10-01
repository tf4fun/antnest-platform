# Lifecycle foundation contract

This document defines what the default lifecycle foundation profile
(`make e2e-lifecycle`) must prove, including the active-Run drain scenario. The
other lifecycle profiles have their own contracts in this directory; see the
[lifecycle README](README.md).

## Lifecycle coverage

The profile covers empty-instance setup, all five lifecycle kinds (create,
rebuild, disable, enable, delete), exact request replay, interleaved global event
cursors and watch resume, network policy CAS, physical workspace retention and
deletion, and required-MCP startup diagnostics. Creation may complete while the
observed Runtime is unhealthy; a failed Runtime startup must not be reported as a
failed lifecycle operation or as an executable Agent.

## Active-Run drain

During a Rebuild, a real Bash process is held after its first physical append.
The same live PID, Runtime, workspace, execution snapshot and open network
attachment are verified before and after an observed exit-zero Agent Controller
restart. ACP rejects competing prompts with `agent_busy`; neither denial may
execute or change the rejected Session. Exact Rebuild replay must remain one
operation. The Tool is then released explicitly, its completed effect is kept,
the Runtime compute is replaced, and the same Session is loaded and executed
against the new Template revision.

## Setup and Trace rules

Setup uses the current Provider and Model APIs, actual Template revisions and an
immutable Runtime image. Per-message protocol Traces are collected, and actual
Provider HTTP spans are bound to durable ACP Runs. Lifecycle Traces must bind the
Gateway admission to the exact Temporal workflow and its activities, SQL,
publication and settlement, and the mutating Runtime and Egress calls. After the
graceful Controller restart, both real Workflow spans and both drain attempts
must be present. Raw spans, warnings and errors are kept unchanged; topology
results are reported separately from strict status. Clocks and exporter
intervals are never changed.

## Verification rules

Negative fixtures come first, followed by serial local and Docker checks. Only
the coordinator operates Docker and processes. Other running deployments are
untouched, and owned cleanup is verified on exit.
