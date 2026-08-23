# Agent Note: Live-assist listens in the session it was started from

Status: implemented

English | [中文](2026-08-23-live-assist-listens-in-the-current-session.zh.md)

## Problem

Starting the interview assist created a new dsh session and switched to it, so the interview never landed in whatever conversation was open. Two things went wrong with that.

The switch could not happen at all from a blank session. `workspaces.startSession()` reuses the workspace's blank session, so requesting a switch out of one hands back the same id; the two-step handoff — record the request in the old session, adopt it in the component that mounts in the new one — then waited for an adopter that never came. The panel sat on "Connecting…" indefinitely with the recognizer never started, and because stopping leaves a blank session selected, every retry landed in the same place.

The switch was also writing interviews into sessions the session list hides. `blank` is derived from the absence of `turn/start` ([api-proxy.ts](../../../../packages/host/apiproxy/src/api-proxy.ts)), and nothing this plugin appends opens a turn, so a session holding an entire interview stays blank. Clients show a blank session only while it is selected and label it "New Session" ([tree.ts](../../../../packages/client/ui-workspace/src/client/tree.ts)), so navigating away removed the interview from the list — and New Session reuses blank sessions, so the next one was appended to the same log. Three such sessions, holding 6, 96, and 296 events under generated titles, were produced in a few minutes of use.

## Decision

Listening runs in the session the composer is mounted in. Nothing is created and nothing is switched to.

`LiveAssistController.start(background, session, share)` opens the socket directly against that session, replacing the `request`/`adopt` handoff and the `awaiting` state it needed. The composer slot is session-scoped, so a session is always in hand at the click, and the controller no longer needs the `workspaces` or `sessions` services at all.

The controller still owns the capture and the socket outside React, because the user may switch sessions while a recognizer runs and that remounts every session-scoped component. Transcripts and answers keep landing in the session named in the `start` message, not in whichever session is on screen.

An interview in a session of its own is still available — the user creates the session first, then starts. That is one deliberate action instead of a switch that fired on every start.

Blankness is not fixed here, so the setup dialog names it: when the mounted session is blank, it says the interview will not clear that bit, that the session will therefore leave the list and be reused, and that sending any message first keeps it. Warning at the one moment the user can act on it costs one injected predicate; the alternative is a session the user cannot find afterwards and no explanation of why.

## Alternatives considered

**Create a new session, but only when the current one is not blank.** This was the shipped behavior after the deadlock was first fixed. It resolves the hang, but keeps writing interviews into blank sessions in exactly the case it takes the in-place path — so the material the user most wants to keep is the material the list hides and the next New Session overwrites.

**Keep creating a session and clear `blank` from the plugin's own events.** This is the fix that would make a dedicated interview session viable, and it remains the right one if interviews should live apart from the conversation. It is out of scope here because it changes what `blank` means for every consumer — a `SessionEventMap` member would have to declare itself conversation content, the generator would have to emit that set, and `api-proxy` would have to fold it on both the attached and cold-probe paths.

**Write a `turn/start` from the plugin so the session stops being blank.** It needs no new vocabulary. Rejected because a turn is one model-loop execution and `dsh-session`'s own invariant checks the turn sequence; a synthesized turn would be a lie the session log validates against.

## Consequences

- Bought: a start that always completes, and an interview that lands in a session the list shows under its generated title.
- Cost: the interview joins the conversation that was open. A user who wants it separate creates a session first.
- The panel's composer control is session-scoped, so there is no start path from the no-session view. That is the same surface the control was already rendered on.
- Interviews started in a blank session still produce a blank session, since nothing here clears that bit. Creating a session and sending anything in it before starting is the way to be sure the list keeps it.

## Testing

`tests/live-controller.client.spec.ts` drives the controller from `start` to a live socket and asserts the `start` message names the session it was given. A second `start` while one runs is refused without touching the running socket or the caller's stream.

`tests/panel.client.spec.tsx` asserts the click path calls `start` with the mounted session and opens no other, that remounting under a different session id neither restarts nor drops a running recognizer, and that the blank-session warning appears only when the injected predicate reports one.

## Related

- [Live counterpart-only meeting assist](2026-08-22-live-counterpart-only-meeting-assist.md) — the bundle, whose start created and switched to a session.
- [Named before listening](2026-08-23-live-assist-named-before-listening.md) — the other half of what a start now does before the recognizer opens.
