# Agent Note: Live counterpart-only meeting assist

Status: implemented

English | [中文](2026-08-22-live-counterpart-only-meeting-assist.zh.md)

## Problem

A participant in a browser meeting wants the model to follow what the other side says and draft an answer, without the model hearing — or answering — the participant's own speech. `dsh-meeting-minutes` already records meetings, but it is a batch pipeline: record, transcode, chunk at 300 s, transcribe, summarize. Its output arrives minutes after the meeting; a live prompt is worthless unless it arrives while the answer is still due.

Two problems have to be solved together: separating the counterpart's audio from the participant's, and shortening the path from spoken question to displayed answer.

## Decision

`packages/meeting/live-assist` is a separate optional Web bundle. `dsh-meeting-minutes` is untouched; the two share only the on-disk model directory.

### Separation is physical, not statistical

The plugin calls `getDisplayMedia` for one shared browser tab and never calls `getUserMedia`. The counterpart's voice is played by the meeting page and lands in the tab's audio; the participant's voice goes from their microphone into the meeting client's uplink and never reaches the tab's output. Speaker diarization is therefore unnecessary — and would have been the wrong tool, because it decides after the fact who spoke, on audio that already mixes both sides.

The cost is reach: only Chromium-family browsers implement tab-audio sharing, and native meeting clients play nothing through a browser tab and so cannot be captured this way at all.

### Whole-utterance recognition, because streaming is unavailable here

Qwen3-ASR supports streaming inference, but only through its vLLM backend, which does not run on macOS. The recognizer therefore segments with silero-vad and transcribes complete utterances through the transformers backend, passing audio as an in-memory `(ndarray, sample_rate)` pair — a form `qwen-asr` accepts, so no audio is written to disk at any point.

That fixes the latency floor at roughly 2–2.5 s: `vadMinSilenceMs` (700 ms) before an utterance is considered finished, 0.5–1.5 s of recognition, and ~500 ms to the first answer token. Lowering the silence threshold trades interruption for speed. If vLLM ever becomes viable on the target platform, streaming recognition would remove the first term and shrink the second.

### Two threads in the worker

Recognition of one utterance takes as long as several seconds of speech, so a single-threaded worker would stall intake and lose audio behind every inference. The worker reads stdin and segments on its main thread and runs the model on one inference thread, with a lock around stdout. Sessions multiplex by id: segmentation state is per session, inference is serial, because the model runs at batch size one.

### Triage is the model's job, on the answer request

A meeting is mostly not questions. Rather than a separate classification request — which would add a full round trip to every utterance — the answer request itself starts with a control line: `SKIP` or `ANSWER`. `ControlLineSplitter` strips that line from the stream, so triage costs nothing beyond the tokens already being generated and the answer streams from the first token after it. A model that ignores the format is treated as answering and its text is preserved: dropping a usable answer is worse than showing an untriaged one.

### Every utterance is answered, in order

Answers are generated one at a time in the order the questions were heard, and a newer utterance never cancels the one being answered.

An earlier version did cancel, on the theory that a counterpart who has moved on has made the previous answer worthless. Real use showed why that is wrong: the recognizer splits on silence, so a pause mid-sentence ends an utterance early and the remainder arrives as a second one moments later. Cancelling threw away the answer to the actual question and kept only the trailing fragment, which then reached the model with no context and was answered as if it were a question of its own. Queueing costs latency when questions genuinely stack up; cancelling cost the answer the interviewee was waiting for.

Nothing merges a split utterance back together — each is answered in its own right, which is what the interviewee sees as "every question got an answer".

### The exchange lives in a dsh session, not in the panel

Starting a recognizer creates a new session and switches to it. Each transcript and each answer fragment is appended there as a `live-assist/*` event, and the conversation view renders them through a `ConversationNodeDefinition` that folds one utterance plus its answer events into a single chat node. The socket carries only live status — speech boundaries, readiness, failures — because that is the only thing with no reason to outlive the call.

This reverses an earlier decision to keep the interview in memory and write nothing. The reversal buys a reviewable, reloadable record and costs privacy: everything the counterpart said is on disk in plain text until the session is deleted. It also inherits the vocabulary rule every optional plugin's events live under — a build without this bundle refuses to reconstruct a session containing them, because `Session.append` exposes no way to mark an event ignorable. Removing the plugin makes past interview sessions unreadable, not merely unrendered.

The session is named from the background material through the same model route, so it is identifiable in the session list without being opened. The rename is fire-and-forget: audio is already flowing when the title request returns, so a naming failure leaves the default name rather than delaying or failing a start. It uses `SessionTitleService.rename`, which pins the title as a user rename and stops automatic generation from scheduling — correct here, because an interview session has no user prompts for the automatic providers to work from.

The panel collapses to one composer row while a recognizer runs: a status dot, what it is doing, pause, and stop. A session-scoped slot remounts when the session changes, so the capture and socket lifecycle lives in a controller outside React, and a start is a two-step handoff — the composer of the old session records the request, and whichever component mounts in the newly created session adopts it with that session's id.

A new session is created only when the current one already holds a conversation. `workspaces.startSession()` reuses the workspace's blank session, so requesting a switch out of a blank session hands back that same id: nothing remounts, the handoff waits for an adopter that never comes, and the panel sits on "Connecting…" until the user stops it — with the recognizer process never started. A blank session is listened in as it is: it is the session New Session would land in anyway, so this both breaks the deadlock and keeps the guarantee that an interview never lands in the conversation you had open. The controller distinguishes the two starts accordingly: a request naming a session that must not adopt it waits for the switch, and one naming none is adopted in place by the next `adopt`.

## Alternatives considered

**Writing `user/message` and `assistant/message` instead of own event types.** It would have rendered for free in the existing chat view and stayed visible to a later agent turn in the same session. Rejected because `agent-loop` is the only writer of `assistant/message` in this repository: those events mean "the model replied through the loop", and forging them would make a plugin's suggestion indistinguishable from an agent turn in the log, in derived history, and to both SDKs.

**Driving a real agent turn per question.** Standard in every respect, and the answer would be an ordinary assistant message. Rejected on latency and shape: the loop assembles a full system prompt and tool catalog per request and may call tools, which is seconds of delay and an answer written to be read rather than spoken. A dedicated preset could strip that down, but the seam would still be one built for autonomous work, not for a two-second prompt.

**Extending `dsh-meeting-minutes`.** Its lifecycle is durable-artifact processing — storage, retry, reprocessing, downloads — and none of it applies to a session that persists nothing. Sharing the package would have meant two unrelated lifecycles behind one settings surface.

**Extracting an ASR capability seam first.** The clean end state is a `dsh-asr` Service Definition with local and remote providers, consumed by both packages. It was deliberately deferred: batch chunk transcription and live VAD-segmented recognition have not yet shown their common interface, and inventing one from a single new consumer would have fixed the wrong contract. The duplicated model-directory check between the two packages is the known cost, and is the signal to revisit.

**A cloud streaming ASR provider.** Lower latency and better Chinese accuracy, but it sends meeting audio off the machine. Local-only was chosen for this bundle; a remote provider belongs behind the seam above, not bolted onto this package.

**Capturing both sides and separating them by diarization or echo cancellation.** Rejected as described under the decision: strictly worse than a separation the capture path already gives for free.

**Mixing microphone and system audio, as `dsh-meeting-minutes` does.** Correct for minutes, where every voice belongs in the record; here it would put the participant's own words into the transcript and prompt the model to answer them.

## Consequences

- Bought: the participant's speech cannot reach the transcript, by construction rather than by filtering; the exchange is a reviewable session that survives a reload; and answers begin arriving about two seconds after a question ends.
- Cost: Chromium-family browsers and browser-based meetings only; latency bounded below by whole-utterance recognition; a second resident copy of the Qwen weights when this bundle runs alongside `dsh-meeting-minutes`.
- The Host holds one recognizer process, released after `workerIdleShutdownMs` without a session, so an idle machine does not retain accelerator memory.
- `maxSessions` bounds concurrent panels; the socket refuses upgrades beyond it rather than degrading every session.
- Serialized answers mean a burst of questions makes the later answers late. That is the deliberate trade against losing an answer entirely.
- Everything the counterpart says is written to session storage in plain text. Audio never is: it is decoded in memory and handed to the model as an array.
- The answer stream is logged one delta at a time, mirroring `assistant/chunk`, so a long interview's log is dominated by answer fragments.

## Testing

The TypeScript half runs in the repository's `pnpm run test` lane at 100% per-file coverage, including a real `ws` client against a real HTTP server for the socket lifecycle and a real Loader composition for plugin registration and teardown.

The worker's utterance segmentation is tested in `packages/meeting/live-assist/python/test_segmenter.py` against a scripted stand-in for `VADIterator`. Those tests found the two defects that mattered most: `VADIterator` already applies `speech_pad_ms` to both coordinates it reports, so padding them again spliced in neighbouring speech; and the minimum-utterance floor has to discount that padding, or a 150 ms cough padded to 550 ms survives a 400 ms floor. They need only numpy, but CI's Python lane covers `python/sdk` alone, so they are not wired into it and must be run directly:

```bash
python3 -m pytest packages/meeting/live-assist/python
```

That gap is deliberate and is the main uncovered risk in this package: a regression in segmentation would not be caught by CI.

## Related

- [`dsh-meeting-minutes`](../../../../packages/meeting/meeting-minutes/README.md) — the batch counterpart sharing the model directory and the model-completeness check.
