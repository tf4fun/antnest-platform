# Browser workspace entry

Decision for [#64](https://github.com/tf4fun/antnest-platform/issues/64): choose
**A, remove the unused direct Gateway browser stack**. Keep the Agent UI Bridge
as the browser path. The detailed behavior and admission gates are in the
[retirement contract](../../contracts/edge-gateway/workspace-entry-retirement.md).

The shipped UI uses `/api/app/workspace/v1/*` through the Agent UI Node service.
The older bootstrap, state/watch and cookie-authenticated ACP aliases have only
test consumers. Maintaining both requires duplicate authorization, header,
stream and capacity handling. Their same-origin cookie authentication does not
serve external IDE/CLI clients. No external ACP client product is introduced by
this change; that would require a separate identity and admission design.

Gateway owns public Origin, Cookie/CSRF and trusted forwarding. Agent UI owns
browser DTOs and Bridge lifecycle. ACP retains protocol, Session and Run
authority through its authenticated private interfaces. Retiring a Gateway
path does not remove private ACP v1/v2 or change accepted-Run semantics.

Gateway revision 24 and header registry revision 2 implement the retirement.
The active route and caller catalogs retain the Bridge and reject the old direct
paths before downstream forwarding. Browser consumers use real Bridge DTOs and
commands; private protocol tests use authenticated owning-service entrypoints.
Receiver catalogs and deployment credentials remove the unused Gateway grants.
Service batches and consumer Docker admissions are recorded separately in the
[delivery queue](../../TODO.md); complete integration CI remains a merge gate.

Deleting the old global four-message semaphore does not fix or prove Bridge
capacity. Review its global stream/owner budgets and body-processing costs,
and require actual two-user attachment/cancellation evidence through the
shipped path. In particular, validate both incomplete upload and body
completion, and count actual execution termination within the one-second
bound. Implementation, consumers and explicit cross-service integration are
separate delivery batches; the decision alone does not complete #64.
