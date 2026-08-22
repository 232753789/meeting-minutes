# Agent Note: Live-assist names the session before it listens

Status: implemented

English | [中文](2026-08-23-live-assist-named-before-listening.zh.md)

## Problem

Starting the interview assist put a recognizer on the air against a session that showed nothing about the run it had just opened. Two things were missing at exactly the moment the interviewee stops looking at the screen and starts talking to a counterpart.

The session was named asynchronously, so it appeared in the list under its default name and was renamed at some later point — usually a second or two in, sometimes never, when the title request failed. An interviewee running back-to-back rounds saw a list of same-named sessions and could not tell which was which until each was opened.

The background material was in the log and in every answer request, but nowhere on screen. The material is edited in a dialog that closes on start and is kept in browser storage across runs, so what a given run was actually started with was unverifiable from the conversation: a stale résumé from a previous round produced answers about the wrong job with nothing on screen to explain why.

## Decision

Starting a run does three things in order, and the recognizer opens last.

The opener `live-assist/started` is projected by its own `ConversationNodeDefinition` into a chat node that renders the material in full, verbatim and with its line breaks. Every answer request in the run carries exactly that text, so the node is a faithful record of the run's input rather than a summary of it — truncating it would defeat the point of showing it. A run is identified by the opener's own sequence number, so stopping and starting again in one session opens a second run with its own material and its own node.

The title request then runs to completion before `LiveAsrWorker.open`. The session therefore carries its name from its first frame, and the state where a session is already recording under a default name does not exist.

A name is not worth failing a start over. A missing `sessionTitle` service, a title the model declined to produce, and a failed request all leave the default name and continue to the recognizer. A naming cancelled by the session's own end is not logged as a failure, matching how a cancelled answer is handled, and a start that disposal overtook while naming was in flight returns without opening the recognizer at all.

## Alternatives considered

**Keep naming fire-and-forget and only add the material to the conversation.** This was the shipped behavior and costs no start latency. It loses because the default-named window is worst exactly where the feature is used: an interviewee lining up several rounds is the same person who cannot afford to stop and rename sessions mid-interview, and the window is unbounded when the title request fails or hangs behind a slow route.

**Write the material as a `user/message` so the ordinary chat renderer displays it.** It would need no renderer of its own. Rejected because `intervieweeNotes` reads `user/message` as things the interviewee typed to steer later answers, so the material would be fed back into every answer request a second time, and because a synthesized user message is indistinguishable in the log from one the interviewee actually sent.

**Show the material in the panel instead of the conversation.** The panel is one composer row by design, and the material is exactly the kind of content that should survive a reload and be reviewable afterwards — which is the argument that put the transcript and answers in the session to begin with.

**Name the session from the first transcribed question instead of the material.** It would need no request before listening, since the name would arrive with the first utterance. Rejected because the first thing a counterpart says is usually a greeting, and because it reintroduces the default-named window it was meant to remove.

## Consequences

- Bought: a session that is identifiable in the list from its first frame, and a conversation that shows which material the run was started with.
- Cost: one model request of start latency, bounded by `titleMaxOutputTokens`. The panel stays on its connecting state through it, and anything the counterpart says in that window does not reach the transcript.
- The material is in the conversation in plain text, so sharing an entire screen exposes it exactly as it exposes the panel.
- An empty background material produces no title request at all — `generateTitle` returns early — so a run started without material pays no start latency and keeps the default name.

## Testing

`tests/session.spec.ts` asserts the order directly: a fake worker records its open into the same array the rename writes to, so the start is pinned as rename-then-open rather than merely both-eventually. The disposal race is covered by holding the title stream open, disposing mid-start, and asserting that nothing was renamed, nothing was logged as a failure, and the recognizer was never opened.

`tests/background-definition.client.spec.ts` covers the projection, including a second run in one session getting its own node, and `tests/panel.client.spec.tsx` asserts the card renders the material without collapsing the whitespace the interviewee typed.

## Related

- [Live counterpart-only meeting assist](2026-08-22-live-counterpart-only-meeting-assist.md) — the bundle this changes, whose naming was fire-and-forget.
