# Skill Registry management in Admin Console

This document describes the administrator-facing Skill inventory, upload,
discovery and promotion workflows in Admin Console, and how Templates and
Agent lifecycle commands consume fixed Skill versions.

Admin Console owns the administrator-facing Skill inventory and upload workflow.
Skill Registry remains the authority for organization-scoped packages, immutable
versions and artifact bytes. The browser calls only `/api/admin/skills...` through
the existing authenticated Edge route; it never receives the Registry service
token or selects the organization/actor used for publication.

Skill routes require `ANTNEST_SKILL_REGISTRY_URL` and
`ANTNEST_SKILL_REGISTRY_API_TOKEN`. When the Registry URL is not configured,
these routes return `503 dependency_unavailable` and the rest of the Console
keeps working.

## Discovery and promotion

The [source/promotion contract](../../../contracts/admin-console/skill-discovery.md)
adds search, preview and promote POSTs under `/api/admin/skill-sources/`. These
use the same administrator admission and the authenticated caller's own source
access. An administrator cannot substitute another Agent owner's identity.
**Discover Agent Skills** searches live mappings, then shows a bounded package
preview before explicit promotion. New formal Skills and same-name appended
versions retain exact source ref/digest, target CAS and a stable command key
after uncertain failures. A deterministic conflict requires fresh review.
Publication success and inventory refresh are separate; failed refresh does
not publish again. Formal versions remain fixed Template choices applied by
explicit rebuild.

Preview keeps package bytes only in bounded request memory, streams canonical
digest/checksum verification, and returns UTF-8 SKILL.md plus file metadata.
It shares the two package-processing slots with publication and retains no ZIP
cache. Responses are no-store. Registry's terminal empty-string/zero cursors
are normalized to browser null so the final page can identify the current head.

## Inventory and publication

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

Skill publication uses an accessible ZIP picker with package name/size feedback,
an explicit Cancel action, and a disabled publish action until a package is
selected. Cancelling clears the selection; retrying a failed upload retains the
same File object and its existing idempotency behavior.

The Console navigation exposes **Skills** under Configuration. Administrators
can list, search loaded rows, inspect versions, upload an initial package,
publish a new immutable version after reaching the current head, and download
a fixed version. Publishing does not update Templates or Agents automatically.

## Templates and Agent lifecycle

The [Skill Registry design](../../../docs/skill-registry-minimal-design.md)
assigns fixed-version Template references to Agent Controller and Runtime
preparation and mounts to Runtime Controller. The BFF accepts fixed
`{skill_id, version}` references on both Template creation and revision,
forwards them to Controller, and projects Controller's frozen Skill metadata
and set digest on current and historical reads. The Template creation and
revision forms select an explicit published version, allow removal, and retain
the current frozen versions when opening a revision. An empty `skill_refs`
array clears a new revision's preset set; publishing a new Skill version never
changes an existing Template revision or Agent.

During Agent creation, the BFF reads Controller's organization-scoped
preparation state and exposes only state, progress and retry metadata. A
browser read by the original idempotency key derives the same lifecycle request
ID without exposing the derivation rule. The creation dialog retains the
selected command while preparation is pending and offers an explicit retry with
the same body and key. Rebuild uses a progress panel inside its dialog and keeps
the original target Template and request key; Enable shows progress on Agent
detail while the Agent remains disabled. Both operations explicitly retry their
frozen command. Publication, frozen configuration, Runtime readiness and actual
Run usage remain distinct states in the Console.

The Console audit projection drops legacy `skillInstructions`, including
historical and malformed nonempty snapshots. Skill content reaches a Runtime
through its read-only volume and on-demand read path, not the audit response.

## Deployment

Development Compose provisions a dedicated PostgreSQL role/database through an
idempotent one-shot job and places Registry on `skill-registry-database` plus
`development`; it is absent from `runtime-management` and `egress`. Console
uses the same configured token as Registry. The synthetic default token and
database password are for disposable local development; deployments must set
their own values. Platform backups must include the Registry database before
production use; see [Docker backup and restore](../../../docs/docker-backup-restore.md).

## Testing

- Browser tests (synthetic API responses, desktop and mobile):
  `npm --prefix services/admin-console/web run test:browser:skills` and
  `test:browser:template-skills`.
- [`tests/e2e/skill-registry/console-management.mjs`](../../../tests/e2e/skill-registry/console-management.mjs)
  runs real Registry, PostgreSQL and Console containers: initial and revision
  publication, identical replay, stale-head rejection, scoped listing and
  download, cross-organization hiding and member rejection. A catalog dependency
  stub verifies that Console forwards fixed Template references and preserves
  historical frozen metadata.
- [`tests/e2e/skill-registry/console-login.py`](../../../tests/e2e/skill-registry/console-login.py)
  runs against real Identity, Gateway, Console and Registry containers: an
  unauthenticated request is rejected, an administrator login can publish and
  list a Skill, and a forged organization header does not change the visible
  scope.
- `make e2e-stage3-skill-delivery` covers the Template to Runtime chain with real
  ACP Runs before and after a changed-Template rebuild.

For an isolated run of `console-management.mjs`, build the Registry and Console
images, start `postgres`, `skill-registry-database-init` and `skill-registry`
under a dedicated Compose project, then run the script with
`ANTNEST_E2E_COMPOSE_PROJECT` set to that project name. The script starts and
removes only its Console test container; remove the isolated Compose project
and volume afterwards.
