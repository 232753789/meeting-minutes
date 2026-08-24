# Agent Note: One drawer for the composer's tools

Status: implemented

English | [中文](2026-08-23-composer-tool-drawer.zh.md)

## Problem

Two plugins had taken `conversation.input.left` as a place to hang a feature: meeting minutes as a bare microphone glyph, live interview assist as a ghost button reading "面试助手". Neither reads as the same kind of thing, the row grows by one control per plugin, and the composer tool row is the width the textarea does not get. A third such plugin makes the row the problem rather than the feature.

The seat also gave the user nothing to read. A glyph alone does not say what recording does with the audio, and a text button spends row width to say only a name — neither surface has room for the sentence that decides whether someone opens it at all.

## Decision

A new list slot, `conversation.input.tool`, holds features the user opens; `conversation.input.left` keeps its original meaning — a small control that carries its own affordance beside the resident chrome.

Each entry renders **twice per session**, and the occurrence tells it which face to draw through `ComposerToolSeat.surface`:

- `bar` — the icon in the tool row, the running tool's status and controls, and the entry's own dialog.
- `drawer` — one row inside the expandable panel: icon, name, and a sentence saying what the tool does.

`ComposerToolDrawer` renders the row, the chevron toggle, and the panel above it, one occurrence per ledger id via `renderSlot(..., { only: id })`. The whole drawer renders nothing while no entry is registered, so a deployment without these plugins pays no layout.

**The drawer holds the open flag, not the entry.** Two occurrences of one entry cannot each own a dialog, and the icon and the drawer row have to reach the same one; the flag therefore lives in the drawer, per entry id, and reaches each occurrence as `open` / `setOpen`. Opening from a row also closes the panel, which would otherwise cover the surface the row just opened. One tool is open at a time — these dialogs are modal.

**A running tool stays on the `bar` surface.** The drawer unmounts its rows when it closes, so a status the user must watch — a recording timer, a recognizer's listening state — cannot live there. `bar` is the occurrence that outlives the panel, and it is also the one seated in the row the user is already looking at.

The drawer needs no icon or description metadata on the registration, because the entry draws both faces itself. What the drawer projects from the ledger is the id list alone, subscribed the same way the view ring is.

The shared row chrome is `ChoiceRow` in `ui-primitives`: icon, title, an optional two-line description, and an optional trailing status. It sits there rather than in `ui-conversation` because the client bundle purity gate admits `ui-primitives` as a platform module and refuses a cross-plugin value import from `ui-conversation/client` — and because both meeting plugins would otherwise hold the same fifteen lines of row markup.

## Alternatives considered

**Static `icon` / `description` metadata on the registration, with the drawer drawing every face.** This is the version where entries stay one-occurrence and the drawer owns all presentation. It needs a per-slot entry-metadata mechanism in `ui-slots` (the `KindOptions` list arm carries `id` / `order` / `label` and nothing extensible), a thunk convention so the copy follows the active locale, and a typed read path for owners. Rejected as the larger change for the smaller result: `surface` gives the entry the same two faces while leaving every localized string in the plugin that owns it, and lets a running tool draw something the drawer could not have described.

**One entry occurrence, with the open flag inside the entry.** What both plugins did before. It cannot work once the icon and the drawer row are separate DOM: the two occurrences hold two `useState`s, and clicking the drawer row opens a dialog inside a subtree that unmounts with the panel.

**Collapse everything behind a single "tools" entry point.** Fewest pixels, but it puts every tool one extra click away and hides the running state that the tool row is the right place to show. The icon row keeps a started recording visible without opening anything.

## Consequences

- Bought: a row that grows by one icon per plugin instead of one labelled control, and a place where a tool can say in a sentence what it does.
- Cost: an entry taking this seat writes two render branches. That is the price of one registration covering both faces, and the drawer branch is a `ChoiceRow` call.
- `conversation.input.left` has no shipped occupant now. It stays declared: a control with its own affordance next to the access-mode and plan chrome is a different seat from a feature the user opens.
- The panel is positioned against the tool row, not portaled. It opens upward because the row sits at the composer card's floor.

## Testing

`ui-conversation/tests/skeleton.client.spec.tsx` mounts the root with a stub ledger: no entry renders no chrome at all; entries render `bar` occurrences closed and `drawer` occurrences only while expanded; a drawer row's `setOpen(true)` closes the panel and leaves the flag on that entry's `bar` occurrence alone; a second tool's seat takes the flag from the first; an outside pointerdown dismisses the panel without disturbing what is open.

`live-assist/tests/panel.client.spec.tsx` and `meeting-minutes/tests/browser-plugin.client.spec.tsx` drive both plugins through a host that holds the flag the way the drawer does, and assert the drawer face names the tool and describes it, while a listening recognizer reports its state there instead of offering to reopen setup.

## Related

- [Live counterpart-only meeting assist](2026-08-22-live-counterpart-only-meeting-assist.md) — one of the two entries this seat now holds.
- [Browser meeting minutes](2026-08-19-browser-meeting-minutes.md) — the other.
