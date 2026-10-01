# Console Skill source discovery and promotion

This D6 contract consumes the admitted [Registry discovery API](../skill-registry/discovery-api.md).
It adds three administrator-only routes through the existing authenticated
Gateway → Console path. Organization and actor always come from the trusted
principal; administrator status does not grant access to another owner's
personal Skill. Ordinary members cannot publish through the Console.

| Method and path | Request | Successful response |
| --- | --- | --- |
| POST `/api/admin/skill-sources/search` | `query`, optional `limit` (1–50) | 200 `{items: [...]}` of Agent source mappings |
| POST `/api/admin/skill-sources/preview` | Agent `skill_ref`, `expected_digest` | 200 selected ref/digest, `skill_md`, package file metadata |
| POST `/api/admin/skill-sources/promote` | same selection, optional paired `skill_id` / `expected_version`; `Idempotency-Key` header | 201 immutable formal Skill version |

All request objects and nested references are closed, query parameters are
rejected, and bodies are limited to 4 KiB. Search query is trimmed, nonempty,
at most 256 UTF-8 bytes. Registry searches formal packages and dynamic sources;
Console validates the response then shows only Agent mappings. Results are
bounded, without pagination or an implied complete source inventory. Refine
the query when the result limit is reached. No source URL, owner substitution,
package bytes or publishing authority is accepted from the browser.

Preview loads the selected current package through Registry, without installing
it in a Runtime. The BFF bounds the archive (8 MiB), entries (256), unpacked
content (32 MiB), and root `SKILL.md` (16 KiB); verifies artifact and canonical
content digests and entry checksums; returns UTF-8 text as data plus real-file
metadata. It does not execute or render Skill Markdown as HTML and does not
retain a package copy. Registry owns package/frontmatter validity. Responses
are projected through an allowlist and are `Cache-Control: no-store`.

The user reviews source Agent, name, sequence, digest, text and attachments,
then explicitly confirms promotion. Create omits both target fields. Append
requires an explicitly selected existing same-name formal Skill and its
current version, without substituting a newer head. The browser retains the
same promotion command key after transport errors, 408/429 or 5xx; successful
replay uses Registry's receipt even if the source is later unavailable. A
changed selection/target starts a different command. Deterministic 4xx clears
the pending key. `content_changed`/409 requires a fresh search and preview;
`revision_conflict`/409 requires review of the current formal head. Neither
error automatically changes or retries the selection.

Console derives Registry's request ID using the existing organization-scoped
Skill command namespace. Registry owns source reauthorization, source byte
validation, CAS, promotion provenance and atomic immutable publication.
`not_found`/404 hides inaccessible sources, `source_unavailable`/503 and
`source_invalid`/502 remain visible dependency failures. Registry 401 maps to
a dependency error rather than expiring the browser session.

Promotion does not remove or pause the source, change its learning policy,
change Templates, rebuild Agents, or make a dynamic ref a Template ref. After
success the UI refreshes formal inventory separately; refresh failure never
repeats publication. The formal version is eligible for the existing fixed
Template selection and explicit rebuild workflow. A complete cross-service
four-step acceptance remains the DI1 integration batch.

Wire shapes are in [the schema](skill-discovery.schema.json). Runtime temporary
file delivery and ACP cleanup are already admitted in
[D4A](../../docs/skill-discovery-temporary-consumer-delivery-20261001.md).
