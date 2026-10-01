# Antnest Product Design Language

This document is the canonical visual and interaction contract for the Antnest
browser products.

Antnest has two browser products with different jobs but one visual identity:

- **Admin Console** is a dense operational surface for administrators.
- **Agent UI** is a calm conversation workspace for end users.

The products may use different component implementations, but they must share
the tokens, interaction tone, and structural rules in this document.

## Product Character

Antnest should feel like durable workplace infrastructure: quiet, precise, and
approachable. It is not a marketing site and should not look like a generic
blue SaaS dashboard. The visual signature comes from warm neutral surfaces,
near-black commands, one restrained lime signal, compact information density,
and visible system state.

## Canonical Tokens

| Role | Value | Usage |
| --- | --- | --- |
| Canvas | `#f7f7f5` | full-page background |
| Paper | `#fbfbfa` | primary work surface |
| Sidebar | `#efefec` | persistent navigation |
| Border | `#deded9` | dividers and control outlines |
| Ink | `#1d1d1b` | primary text and commands |
| Ink soft | `#4b4b47` | secondary labels |
| Muted | `#62625d` | metadata and inactive controls; keeps small text at WCAG AA contrast on Canvas |
| Signal | `#dbff54` | sparse active or live emphasis |
| Signal strong | `#a6d000` | signal text and focus detail |
| Danger | `#c23f35` | destructive and failed states |

Signal lime is not a page background or decorative gradient. It marks one
important local fact: current selection, live activity, or the Antnest brand
detail. Near-black remains the primary action color.

Typography uses `DM Sans` when available and the system sans-serif stack as a
fallback. IDs, timestamps, model names, and machine state use `DM Mono` or the
system monospace stack. Text sizes remain stable across viewport widths.

## Layout Grammar

1. Persistent navigation uses a light sidebar separated by one border.
2. Work areas are unframed paper surfaces. Cards are reserved for repeated
   records, messages that need containment, dialogs, and tool activity.
3. Corners stay compact: 4-8 px for controls and no more than 8 px for cards.
4. Page headings describe the current object or task; they are not hero copy.
5. Dense administrator pages favor tables and aligned rows on wide viewports.
   On narrow viewports, each record becomes a compact resource summary with
   its essential state and commands in the normal reading flow; horizontal
   scrolling must not be the only way to discover an action. Conversation
   pages favor a narrow readable thread and a stable composer.
6. Mobile navigation becomes an overlay while the primary action remains
   reachable without horizontal scrolling.

## Interaction Grammar

- Use Lucide icons for familiar actions and pair unfamiliar icon-only actions
  with an accessible label and tooltip.
- Show state where work happens. Busy, reconnecting, queued, and failed states
  must not be hidden in a separate diagnostics page.
- Dynamic failures announce only their error text through `role="alert"`.
  Non-error loading and completion use polite status announcements. A control
  that owns an active asynchronous request exposes `aria-busy`; controls that
  are merely unavailable because of a prerequisite must not pretend to be
  running.
- Collapse tool details by default. Keep the tool name, status, and duration
  scannable without exposing internal Run terminology to end users.
- Disable unavailable actions and explain the blocking state next to the
  action. Do not accept input that the system cannot submit.
- Use inline feedback for recoverable problems and dialogs only for destructive
  confirmation or focused creation flows.
- Once a dialog submits a mutation, its Cancel, close, Escape, and outside-click
  exits remain unavailable until the command is accepted or rejected. An
  accepted long-running lifecycle command may then close the dialog because
  the owning resource page exposes its authoritative progress.
- A completed synchronous administrator mutation gets a persistent,
  dismissible inline confirmation announced with `role="status"`. Do not use
  auto-expiring toasts for operational results. When the result already has an
  authoritative surface, such as Agent lifecycle state/events or the one-time
  SCIM credential dialog, that surface is the success acknowledgement.
- Motion is functional and short. Avoid ornamental motion, floating shapes,
  gradients, and layout-shifting hover effects.

## Brand Use

The Antnest mark is a near-black square with a lime network/workflow glyph.
Product labels sit beside it:

- `Antnest / Control` for the administrator product;
- `Antnest / Workspace` for the end-user conversation product.

The mark, base colors, typography, and interaction state colors are shared.
Navigation density and page composition may differ because the products serve
different workflows.

## Accessibility And Responsive Rules

- Body text and controls must meet WCAG AA contrast against their surface.
- Every interactive element is keyboard reachable and has a visible focus
  state.
- Form labels name their controls directly. Supporting hints use
  `aria-describedby` so assistive technology announces them as descriptions,
  not as part of an increasingly long control name.
- A closed mobile navigation drawer is removed from keyboard traversal. Opening
  it moves focus to its close control; dismissing it restores the trigger, and
  choosing a destination moves focus to the newly displayed main content.
- Color never carries status alone; pair it with text or an icon.
- Controls maintain stable dimensions while labels wrap or truncate safely.
- Resource inventories preserve their essential facts and row actions when
  switching between desktop tables and mobile summaries.
- The layout supports 320 px wide viewports without overlapping text, tool
  activity, attachments, or the composer.

## Change Rule

A new product-local token must first be mapped to a semantic role. If the role
is shared, update this document and both browser products. If it is truly local,
keep it in that product and do not silently redefine a canonical token.
