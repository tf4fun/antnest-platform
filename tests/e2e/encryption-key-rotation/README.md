# Stored-secret key rotation acceptance

Run `make e2e-encryption-key-rotation` serially with NVM's pinned Node and Docker.
This extends the full authenticated deployment/Skill propagation fixture after
both owning services have passed their local gates. All candidate images are
built from the checkout, all encryption/authentication material belongs to the
fresh isolated fixture, and the Provider is a deterministic local double.
No external model or operator credential is used.

An existing Agent/Runtime and saved Provider are created before rotation. The
fixture then adds a second key to Controller and Identity, switches their active
IDs, runs each real binary's `rekey --batch-size 1`, repeats the commands, verifies
all three sealed tables finish at zero, and removes the old key. Historical OIDC
rows are generated only from the fixture's synthetic key/data. Business fields
and the native Runtime's container, start time, restart count and spec digest
must remain unchanged. Existing Gateway sessions and a new login still work;
saved Provider model discovery authenticates after retirement.

The subsequent actual ACP/Runtime workflow proves existing Agent execution,
learning/notices, temporary Skill use and explicit Template/rebuild operations
still work with the old encryption keys absent. The existing network,
authentication and Trace checks also run. Owner PostgreSQL tests separately prove
an actual OIDC callback started before conversion completes after retirement.

Ignored private evidence records progress summaries, continuity and fixture
cleanup under `artifacts/verification/skill-deployment-20261001/<project>/`.
Every created resource and candidate tag is removed; the parent fixture compares
the final resource inventory to its baseline so retained deployments are unchanged.
