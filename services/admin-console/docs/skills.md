# Skill Registry management in Admin Console

Admin Console owns the administrator-facing Skill inventory and upload workflow.
Skill Registry remains the authority for organization-scoped packages, immutable
versions and artifact bytes. The browser calls only `/api/admin/skills...` through
the existing authenticated Edge route; it never receives the Registry service
token or selects the organization/actor used for publication.

The BFF reads organization and actor from the trusted Gateway principal. List
and version cursors are bounded and have a separate page/retry state. Uploads
accept one ZIP (8 MiB maximum) with at most two concurrent BFF uploads;
revision uploads additionally require the
current version. The BFF creates Registry multipart metadata itself and derives
an organization-scoped publication request ID from the browser's
`Idempotency-Key`. The browser retains that key for an uncertain response to
the same ZIP bytes and expected head, then clears it after a confirmed result
or a deterministic 4xx rejection. Registry owns the CAS and receipt semantics.
Responses are projected through a metadata allowlist. Artifact downloads are
scoped, size bounded, digest checked and served as attachments. Registry 401 is
a dependency failure, not a browser-session expiry.

The Console navigation exposes **Skills** under Configuration. Administrators
can list, search loaded rows, inspect versions, upload an initial package,
publish a new immutable version after reaching the current head, and download
a fixed version. Publishing does not update Templates or Agents automatically.
The [Stage 4 design](../../../docs/skill-registry-minimal-design.md) assigns
fixed-version Template references to Controller B2, Runtime preparation and
mounts to RC B3, and the full chain to I1. The BFF now accepts fixed
`{skill_id, version}` references on both Template creation and revision,
forwards them to Controller, and projects Controller's frozen Skill metadata
and set digest on current and historical reads. The Template creation and
revision forms select an explicit published version, allow removal, and retain
the current frozen versions when opening a revision. An empty `skill_refs`
array clears a new revision's preset set; publishing a new Skill version never
changes an existing Template revision or Agent. During Agent creation, the BFF
reads Controller's organization-scoped preparation state and exposes only state,
progress and retry metadata. A browser read by the original idempotency key
derives the same lifecycle request ID without exposing the derivation rule.
The creation dialog retains the selected command while preparation is pending
and offers an explicit retry with the same body and key. Rebuild uses a progress
panel inside its dialog and keeps the original target Template and request key;
Enable shows progress on Agent detail while the Agent remains disabled. Both
operations explicitly retry their frozen command. The user-approved desktop/
mobile previews, full web unit/component suite, and isolated Docker BFF scope
and projection regression pass for all three operation kinds. The real
Controller/RC/ACP business flow has separate I1 integration evidence from
`make e2e-stage3-skill-delivery`. Publication, frozen configuration, Runtime
readiness and actual Run usage remain distinct states in the Console.

The B4 Console audit projection also drops legacy `skillInstructions`, including
historical and malformed nonempty snapshots. Skill content reaches a Runtime
through its read-only volume and on-demand read path, not the audit response.

Development Compose provisions a dedicated PostgreSQL role/database through an
idempotent one-shot job and places Registry on `skill-registry-database` plus
`development`; it is absent from `runtime-management` and `egress`. Console
uses the same configured token as Registry. The synthetic default token and
database password are for disposable local development; deployments must set
their own values. Existing platform backups must be extended to include the
Registry database before production use. The scoped Docker E2E
[`tests/e2e/skill-registry/console-management.mjs`](../../../tests/e2e/skill-registry/console-management.mjs)
has passed with real Registry, PostgreSQL and Console containers: initial/revision
publication, identical replay, stale-head rejection, scoped listing/download,
cross-organization hiding and member rejection. Its B4b extension uses a catalog
dependency stub to verify the deployed Console forwards fixed v1/v2 Template
references and preserves historical frozen metadata. The separate Registry → RC
→ real Runtime Docker check verifies preparation, read-only `/skills`, discovery
and on-demand read. The separate I1 gate verifies the combined workflow with
real ACP Runs before and after a changed-Template rebuild.
Desktop/mobile synthetic browser acceptance covers the Skill page and Template
creation/revision, including fixed version submission and unchanged-revision
retention. The additional
[`console-login.py`](../../../tests/e2e/skill-registry/console-login.py)
check passed against real Identity, Gateway, Console and Registry containers:
an unauthenticated request was rejected, an administrator login could publish
and list a Skill, and a forged organization header did not change the visible
scope.
Controller/RC installation and the full
Template → Runtime chain remain outside this batch.

For repeatable isolated verification, build the Registry and Console images,
start `postgres`, `skill-registry-database-init` and `skill-registry` under a
dedicated Compose project, then run the E2E script with
`ANTNEST_E2E_COMPOSE_PROJECT` set to that project name. The script starts and
removes only its Console test container; the coordinator removes the isolated
Compose project and volume after recording evidence.
