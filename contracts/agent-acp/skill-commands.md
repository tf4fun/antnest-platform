# Runtime Skill commands

ACP owns Skill discovery and invocation. Agent UI consumes the catalog without
reading Registry packages or accepting client-supplied file paths.

- Each discoverable Runtime Skill is advertised as
  `skill:system:<name>` or `skill:personal:<name>`, with its description and
  `input.hint`. Names containing whitespace, `/`, `:`, `\\` or control characters
  cannot be command tokens. Ambiguous duplicate names within one source are omitted.
- The existing `available_commands_update` carries these commands alongside
  native commands. Delivery checkpoints carry the latest catalog, never reset it
  to a static list. Refresh occurs on Session setup, after a Run and after a
  committed learning notice. Busy/unavailable Runtime discovery must not interrupt
  execution or make Session setup fail; invocation always checks fresh information.
- Initialize response `_meta["antnest.dev/skill-commands"]` contains
  `{version: 1, commands: [...]}` (Skill commands only). This supplies the Agent
  catalog before the first Session exists. The BFF projects it as Agent View
  `skillCommands`, retains only its latest replacement, and updates it from
  subsequent Session catalogs. A new conversation never creates an empty Session
  just to discover commands. Agent switches cannot reuse another Agent's catalog.
- Selecting a command only inserts `/<name> ` into the draft. Sending
  `/skill:<source>:<name> <task>` uses the ordinary Prompt/Run path and existing
  access, concurrency, authorization, model and budget rules. Skill commands are
  not workspace controls and cannot execute while another Run is active.
- At Run preparation, resolve the exact source/name against fresh Runtime info,
  read that Skill's `SKILL.md` using its discovered path, and expand only the latest
  user message for the model. Preserve attachments. Keep the original command in
  conversation storage; never persist the expanded body into context checkpoints.
  Reads are complete UTF-8 content, at most 16 KiB; missing, incomplete or oversized
  Skills and empty tasks fail before model inference, with a clear error.

Delivery batches: ACP producer and tests first; Agent UI consumer and tests next;
then Docker integration and browser verification. Upload-dialog styling is an
independent Admin Console batch.
