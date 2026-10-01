# Agent UI Design Rules

This document defines the visual, interaction, navigation and accessibility
rules for Agent UI and how they are checked.

Agent UI is a session-first work surface behind Gateway. Keep neutral surfaces,
restrained lime selection, readable role colors, and a flat conversation flow.
Do not introduce project navigation or move ACP decisions into presentation
code. The platform-wide rules are in the
[design language](../../../docs/design-language.md).

Reference: [UI UX Pro Max web checklist](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/blob/main/.claude/skills/ui-ux-pro-max/references/quick-reference.md).
Use its accessibility, interaction, responsive layout, and consistency guidance;
its marketing layouts and native-platform measurements are not web requirements.

## Shared Visual Rules

- Colors, control sizes, and radii belong in `styles.css` tokens. Normal text,
  including secondary labels, must meet 4.5:1 against its actual surface.
- Chat prose uses 16px text on desktop and mobile. Compact controls use 12-13px;
  important labels must not shrink to fit. Long titles wrap or can be expanded.
- Buttons have stable bounds, visible keyboard focus, hover/pressed feedback,
  accessible names, and native disabled state. Icon controls use Lucide.
- Compact desktop targets are at least 28px; touch/narrow-screen controls are
  at least 44px. Focus must stay visible inside scroll areas.
- Process is a grouping disclosure, not a container card. Thinking, Tool, and
  Plan share framed disclosure headers. Expanded sections use separators, not
  nested cards. Tool payloads remain literal text.
- The chooser and unselected sidebar Agents show Controller management state;
  the selected Agent and chat header show ACP execution availability. Both use
  the shared text-and-dot treatment, never color alone. Do not treat management
  state as an execution grant or hide status on mobile.
- Approval requests use the shared surfaces with a warning accent. Allow/reject
  remain distinct actions with their server-provided names; UI never invents
  approval policy. Errors have a visible retry or recovery action where available.

## Navigation And Responsive Layout

- Agent selection is a browser page: a centered, 960px content region, heading
  and action toolbar, full-width search, result count, and a two-column grid of
  individual cards. Narrow screens use one column. It does not carry the chat
  sidebar, drawer or conversation controls.
- Each card is an Agent; there is no separate cwd/project level. Cards show Agent name,
  ID and management state; do not invent Session totals or update times before
  connecting. Use real links, preserving modified-click/new-tab navigation.
  Search and refresh do not establish ACP connections. Clear search supports
  both its icon control and Escape. Typography, colors and controls retain the
  workspace tokens; page sections are not floating cards.
- Chat navigation on desktop uses an aside; mobile uses a native modal dialog. Escape/backdrop
  dismiss, focus containment, background inertness, and return focus follow
  browser dialog semantics. Resizing to desktop must remove modality.
- Preserve session/draft state when opening navigation. Agent selection remains
  separate from conversation selection and reveals all available Agent states.
- Use dynamic viewport height and safe-area padding. Composer, usage popup,
  approval requests, and navigation must fit at 320px width and short heights.
- Honor reduced motion. Scrolling code blocks and tables must be keyboard
  reachable; long content must not create page-level horizontal scrolling.

## Session Modification Time

`session/list.updatedAt` is authoritative modification time, not last viewed
time. Loading/replaying history preserves it and must not reorder the list.
New live content advances the projection; explicit server metadata remains
authoritative. The sidebar exposes the exact timestamp on its relative time.
Do not correct a server timestamp by inventing a separate browser access date.

## Composer Controls

Model, permission mode and thinking use compact icon/current-value triggers
inside the composer. Popovers retain ACP provider groups and descriptions,
search models, mark the active choice and support keyboard navigation. Popup
placement is clamped to the viewport; no model catalog lives in Agent UI.

## Testing

For a local development instance, run from the repository root:

```sh
node tests/e2e/workspace-closeout/model-selection-browser.mjs --confirm-development --real-models
```

This opt-in check uses the development bootstrap account, adds DeepSeek V4 Pro
through Console if missing, switches Flash/Pro before two real prompts, reloads
the Session and checks desktop/mobile layouts. It keeps the model and test
conversation for manual review. Screenshots and the compact final result go
to `artifacts/verification/model-selection-acceptance`; credentials are never
included.

`npm test` covers presentation semantics and protocol behavior. The
`npm run test:browser` suite (Playwright with axe accessibility checks) covers
real computed styles, contrast pairs,
disclosure/keyboard behavior, navigation focus, resize, reduced motion, and
responsive layout with deterministic Gateway/ACP fixtures. Screenshots support
visual inspection; they are not a substitute for assertions. Deployed smoke
checks may reuse existing conversations without calling a model.
