# Agent Note: Live-assist answers each question twice, on two models

Status: implemented

English | [中文](2026-08-23-live-assist-second-detailed-answer.zh.md)

## Problem

The interview assist gave one answer per question, and one answer cannot be both things the interviewee needs. What is useful in the first three seconds — a conclusion that can be said out loud and a few bullets to hang it on — is not what is useful thirty seconds later, when the counterpart has asked *why* and the answer needs the mechanism behind the claim, the numbers from the project it came from, and the boundary where the approach stops working.

Tuning the single prompt could not reach both. Asking for depth made the answer arrive too late and too long to scan while someone is waiting for a reply; asking for brevity threw away exactly the material that survives a follow-up. The route was equally overloaded: one model had to be fast enough to be on screen before the interviewee starts talking, and strong enough to reason about a system design question — a model that is one is rarely the other.

## Decision

A Host may name a second route, and every question that gets answered gets answered twice.

`deepProvider` and `deepModel` enable it, must be given together, and resolve into a single optional `ResolvedConfig.deep`, so the deep track's existence is one field's presence rather than four fields agreeing. `deepReasoningEffort`, `deepMaxOutputTokens`, and `deepRequestTimeoutMs` bound that request alone — a reasoning route needs a far longer deadline and a far higher token cap than the fast one, and forcing them to share would make one of the two wrong. Omitting the pair leaves the plugin making exactly the one request it always made.

**Triage stays on the fast track.** The first request keeps its `SKIP`/`ANSWER` control line, and the deep request is queued by that line resolving to `ANSWER` — never by the utterance itself. A greeting therefore costs nothing on the deep route, and the two tracks can never disagree about whether an utterance was a question, which is what independent triage on both would have allowed. The deep prompt states that the decision has already been made and asks for content from its first character.

**The two tracks queue separately.** A deep route is slow by construction, so sharing the fast track's queue would put the next question's short answer behind the previous question's detailed one — the exact latency the fast track exists to avoid. Each track keeps its own promise chain, and `settled()` drains the fast one first because that is what appends to the deep one.

A deep entry captures its history and notes when it is queued, not when it runs. By the time a slow route reaches an entry the session may have answered later questions, and those are not context the question was ever asked in.

Both tracks write the same three answer events, discriminated by a `track` field of `'fast' | 'deep'`, rather than growing a parallel set of `deep-answer-*` event types. The projection folds them into one `ExchangeChatData` holding two `AnswerTrackState` values on the same `pending` → `streaming` → `done` progression, and the card stacks them: the short answer on top, where it lands first and can be read while the counterpart is still finishing, and the detailed one beneath it. Labels appear only when both tracks are present, since a Host without a deep route has nothing to distinguish. A run whose Host named no deep route simply never grows a `deep` track, and the same renderer covers both deployments.

The deep answer is not fed back as history. `QaTurn` keeps the fast answer, which is short enough to carry eight of them and already states the conclusion a later question needs to stay consistent with.

## Alternatives considered

**Fire both requests at once and let each triage independently.** This is the most literal reading of "two answers at the same time" and needs no coordination. Rejected because the two models can disagree: an interviewee would see a greeting answered at length on one track and marked as needing no answer on the other, with no way to tell which judgement to trust. It also pays deep-route tokens for every filler word the counterpart says.

**Wait for the fast answer to finish, then send the deep request with it attached.** The deep model could then avoid repeating what was already on screen. Rejected because it serializes the two tracks end to end — the detailed answer would start a full fast answer late — and because the fast answer is the weaker model's output: feeding it in anchors the stronger model to it rather than letting it reason from the question.

**A `answerRoutes` array of N parallel routes.** More general, and it would make the two tracks symmetric by construction. Rejected because nothing needs a third answer, the UI would have to lay out an unknown number of streaming blocks, and the two roles here are genuinely different — one triages and one does not — so an array of interchangeable routes would misrepresent them.

**Separate `live-assist/deep-answer-*` event types.** It avoids touching the existing events. Rejected because both tracks carry identical information and would need identical projection code twice, which is the asymmetry the repository's symmetry rule exists to catch; a discriminant field keeps one code path.

**Show the two answers in tabs.** It keeps the screen clean when both are long. Rejected because the detailed answer arrives while the interviewee is already reading the short one and is exactly what they turn to when the follow-up comes: a tab hides its arrival behind a click, and would need an unread indicator to undo its own downside.

## Consequences

- Bought: an answer that can be said immediately and, on the same question, one that survives "why". The interviewee chooses by looking down rather than by waiting.
- Cost: a configured deep route roughly doubles requests and more than doubles output tokens per answered question, and bills a reasoning model's thinking on top. The background material and history are paid for twice.
- Detailed answers queue on their own track, so three questions in a row make the third detailed answer late even though its short answer was on time.
- A failed deep request reports to the panel and leaves the fast answer standing; the interview does not depend on the deep route being up.
- The deep track's card is never labelled in a deployment without a deep route, so the existing single-answer experience is unchanged pixel for pixel.

## Testing

`tests/session.spec.ts` covers the coordination the two queues need: that a skipped utterance makes no deep request at all, that no deep request is made without configuration, that a deep failure reaches the panel while the fast answer still completes, and — through a gated deep route holding the queue open across two questions — that neither the request in flight nor the one queued behind it writes an answer after disposal.

`tests/answer.spec.ts` pins the deep request's route, token cap, and reasoning effort, and asserts its system instruction asks for depth and never mentions `SKIP`. `tests/exchange-definition.client.spec.ts` folds interleaved events from both tracks to prove they accumulate independently, and `tests/panel.client.spec.tsx` covers the card in both deployments: labelled and stacked with a deep route, unlabelled without one.

## Related

- [Live counterpart-only meeting assist](2026-08-22-live-counterpart-only-meeting-assist.md) — the bundle this extends, whose single answer route and triage this builds on.
- [Live-assist names the session before it listens](2026-08-23-live-assist-named-before-listening.md) — the start sequence the deep route does not participate in.
