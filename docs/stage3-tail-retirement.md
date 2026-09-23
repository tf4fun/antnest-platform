# Stage 3 historical inline tail retirement

Date: 2026-09-21. This follows [retained seed rejection](retained-seed-retirement.md).
The old setup cannot be reached by supported flags; current profiles dispatch
to their migrated child scripts. This batch removes that unreachable source.

## Removal boundary

- Remove the inline historical setup after migrated dispatch, including old
  Model-owned credentials, revision-pinned Model Templates, duplicate Identity
  flows and old workspace/lifecycle checks.
- Remove its six local shell helpers, unused cookies/URLs/Agent variables,
  legacy Compose fallback branches, retained-success cleanup return and old
  evidence-printing branches.
- Remove `scripts/stage3-workspace-client.mjs`,
  `scripts/stage3-lifecycle-trace-assert.mjs`, and their exclusive
  `tests/e2e/lifecycle-closeout/stage3-trace.mjs` input adapter/test.
- Preserve current profile selection, Docker ownership, deadlines, OIDC
  preparation, current model/client fixtures and all current child launchers.
  Preserve generic lifecycle Trace helpers: historical interrupted-update
  diagnostics still import them, and observability has shared consumers.

The retained-mode rejection and unset/empty/false behavior remain unchanged.
No service, image, retained environment or historical evidence is deleted.

## Verification contract

Before removal, seven exclusive adapter tests and two old cleanup tests pass.
The latter are replaced by three current cleanup cases: success, strict exit 2,
and residual resources forcing failure. They execute the real cleanup function
with bounded command doubles, verify creators stop before resource enumeration,
owned containers are removed, both scope labels are checked, temporary files
are deleted and stale/private evidence is never printed. A corrected fixture
first exposes the old successful-path evidence printing, then passes after removal.

The shared cleanup fixture also had a stale ACP closeout case: it set an empty
profile and expected the old inline JSON. It now uses the current nonempty
`acp-closeout` profile, like its Managed MCP and response-loss siblings, and
requires the parent success summary only after successful cleanup. Child business
results remain separate from the parent's final resource-cleanup result.

Seventeen shell selection checks preserve the migrated default and each flag's
profile mapping, including Identity core/access. They stop before Docker setup;
they do not claim business coverage of every profile. Together with the seven
retained-entry cases, all 27 targeted checks pass. The updated Managed MCP/ACP
closeout/response-loss cleanup cases also pass. The final shared suite passes
1,223 tests with five pre-existing opt-in ACP PostgreSQL commit-receipt checks
skipped and no failures/cancellations. Total 1,228 equals the previous 1,217,
minus seven adapter/two obsolete cleanup tests, plus 17 dispatch/three current
cleanup cases. Existing HTTP/WebSocket/Chromium components remain covered.

Default Stage 3 project `antnest-stage3-e2e-6072` passes deployment checks,
five lifecycle operations, three ACP transports, eight model calls, Provider
credential rotation, preserved build snapshots/Rebuild workspace, logout recovery
and deletion. All five lifecycle plus 29 Session topologies pass. Sixteen strict
timing results fail and exit 2 is retained. Current profile behavior passes without
restoring the removed inline setup.

Identity core initially fails at OIDC Provider registration with HTTP 500 in
projects `antnest-stage3-e2e-6899` and `antnest-stage3-e2e-7156`; local/SCIM checks
pass. A control using the pre-removal entry in `antnest-stage3-e2e-7426` reproduces
the same failure. These failures remain recorded, not reclassified as timing.

The private verification wrapper uses `umask 077`. OpenSSL's public certificate
then has mode 600, while the Identity image runs as nonroot and reads that CA
through a read-only volume. The fixture's Node health check runs as root, so
its health result did not prove Identity could read the CA. A new offline test
reproduces the mode mismatch under 077 and passes under 022. `prepare_oidc` now
explicitly sets only the public certificate to 644; OpenSSL's private key stays 600. Both umask cases pass after the fix. This is a fixture permission correction;
TLS verification and the production Identity service are unchanged.

After adding the two trust-permission cases, the final shared suite passes 1,225
tests with five gated skips (1,230 total), zero failures and zero cancellations.
Final Identity project `antnest-stage3-e2e-8801` passes nine local/SCIM groups and
seven OIDC groups, including browser isolation, subject convergence, credential
rotation, provider disable, replay, nonce rejection and UserInfo fallback.
All ten Identity topologies pass; one OIDC strict timing result fails, preserving
exit 2. The earlier HTTP 500 no longer occurs.

The final default/Identity runs provide 44 passing topologies and seventeen
strict timing failures. The fifteen saved raw lifecycle/Identity traces have
zero missing parents and zero error spans; 29 Session traces pass their existing
request-specific topology checks. No strict result is converted to success and
this is not full-platform strict acceptance. The earlier failed projects and
pre-removal reproduction remain recorded.

Independent cleanup confirms all five projects have no owned containers, volumes
or networks and no verification/browser child processes remain. All twelve
retained development containers preserve identity, images, mounts, networks,
start times and restart counts. Twelve run and eleven configured health checks
remain healthy. No production image is rebuilt/deployed.

Shell syntax, formatting, remaining references, local documentation links and
`git diff --check` pass. Source hashes confirm the four intended deletions;
implementation changes are limited to the entry script, its cleanup fixtures,
and the added dispatch/trust tests. Previous uncommitted work is preserved.
Private coordinator and owned-profile evidence use modes 700/600.

Private pre-change hashes/source snapshots, logs and retained-container baseline
are under `artifacts/verification/stage3-tail-retirement-20260921/`.

The follow-up [separates current interruption helpers](recovery-support-split.md)
from historical startup-gate/SIGKILL assets. Historical graph retirement remains
a separate batch; the current normal committed-response profile does not replace
the historical unfinished-mutation fault scope.
