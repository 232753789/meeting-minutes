# @deepseek-ai/dsh-live-assist

English | [中文](README.zh.md)

Optional Web profile bundle for real-time meeting assistance. Its browser half captures the audio of one shared browser tab, streams 16 kHz PCM to the Host over a loopback WebSocket, and renders the counterpart's transcript above the answers suggested for it; its Host half segments that audio with silero-vad, transcribes each completed utterance through a local Qwen3-ASR model held in memory, decides whether the utterance is a question at all, and streams an answer through `ctx.llm` — plus a second, detailed one from another model when a deep route is configured. Nothing is written to disk. It does not modify `agent-loop` or the shipped Web profile.

## Why only the counterpart is transcribed

The plugin never opens a microphone. It captures the shared tab's playback, and that separation is physical rather than statistical:

- The counterpart's voice is played by the meeting page, so it lands in the captured tab audio.
- Your own voice goes from your microphone to the meeting client's uplink and never reaches the tab's output, so it cannot appear in the transcript.

No speaker diarization is involved, and none is needed. Wear headphones: through speakers the meeting client's echo cancellation reacts to the room and degrades what the recognizer receives.

## Install

Build this checkout and install the bundle into the `web` profile:

```bash
pnpm run build
pnpm dsh plugin --profile web add ./packages/meeting/live-assist
```

**Configure it before starting.** The plugin validates its model directory while the plugin tree loads, so a `localModelPath` that is not a complete model directory fails the whole application's startup, not just this bundle:

```text
dsh: plugin tree failed to load: failed to apply loader entry live-assist
(@deepseek-ai/dsh-live-assist): live-assist: localModelPath is not a directory: …
```

That is the intended loud failure for a misconfigured plugin, but it means the default path has to be right before the first start. Unless your model really sits at `$DSH_HOME/models/Qwen3-ASR-1.7B` and `python3` on `PATH` has both Python packages, add a `live-assist` row to `$DSH_HOME/profiles/web/cordis.patch.yml` naming your own paths — the Configuration section below carries the complete row — then start the existing Web application:

```bash
pnpm dsh web
```

Remove it with:

```bash
pnpm dsh plugin --profile web remove @deepseek-ai/dsh-live-assist
```

## Python dependencies

Install both packages into the Python environment named by `pythonExecutable`:

```bash
python3 -m pip install -U qwen-asr silero-vad
```

Download the complete [Qwen3-ASR-1.7B](https://huggingface.co/Qwen/Qwen3-ASR-1.7B) model directory. One weight shard is not a runnable model:

```bash
python3 -m pip install -U huggingface_hub
hf download Qwen/Qwen3-ASR-1.7B --local-dir "$HOME/.dsh/models/Qwen3-ASR-1.7B"
```

The plugin checks the same file list as [`dsh-meeting-minutes`](../meeting-minutes/README.md) before registering its socket route, and refuses to load against an incomplete directory. Both plugins can share one model directory, but each runs its own process and its own copy of the weights in device memory.

## Using it

1. Open **Interview assist** — its headset icon sits in the composer's tool row, and the tool drawer beside it names every tool it holds — and paste your background material — résumé, target role, projects worth emphasizing. It is kept in browser storage and sent to this machine only.
2. Press **Start listening**. Listening happens in the session you have open; no other session is created. For an interview in a session of its own, create one before you start — and send a message in it, for the reason below. In the browser's share picker, choose the **tab** running the meeting and turn on *Share tab audio*. Keep the share open for the whole call.
3. The dialog closes and the composer keeps one compact row: a status dot, what the recognizer is doing, **Pause**, and **Stop**. Everything else is the conversation.
4. The material you just entered arrives in the conversation first, in full, and the session is named. Listening starts once both are done. You can switch to another session while it runs — the recognizer is unaffected, and transcripts and answers keep landing in the session you started from.
5. Each thing the counterpart says arrives as a message, with the answer suggested for it beneath it. The view scrolls with the newest exchange; scrolling up stops that, exactly as it does for an ordinary conversation.

Every utterance gets its own answer. Answers are generated one at a time in the order the questions were heard, and a newer question never cancels the one being answered — the recognizer splits on silence, so a pause mid-sentence can end an utterance early, and cancelling would throw away the answer to the real question while leaving only the fragment that followed it. The cost is that answers queue: if the counterpart asks three things in a row, the third answer waits for the first two.

**Two answers, when a deep route is configured.** `deepProvider` and `deepModel` name a second model that answers the same question in depth. Triage stays on the fast track alone: the deep request is made only once the fast one has decided the utterance is worth answering, so a greeting costs nothing on it. The two then run at the same time and stream independently — the short answer arrives first, labelled *Talking points*, and the detailed one grows beneath it under *In depth*, with sections for the mechanism behind the question, the matching experience from the résumé, where the approach stops holding, and the follow-ups the interviewer is most likely to ask. Each track queues on its own, so a slow detailed answer never delays the next question's short one. Leave both settings out and the plugin makes exactly the one request it always did.

The material this run was started with is written into the conversation verbatim, as a message of its own. Every answer request carries exactly that text, so it is neither truncated nor summarized: what is on screen is what the model was given.

The session is named from that material by the same model route, and the name is saved before listening starts, so the session is identifiable in the list from its first frame. The cost is one model request of start latency: the panel stays on "Connecting…" through it, and the counterpart is not yet being listened to. A failed request, a title the model declined to produce, and a missing `sessionTitle` service all leave the default name and start listening anyway.

**Send a message in a blank session before listening in it.** Whether a session counts as blank is derived from whether a turn has run in its log, and nothing this plugin appends opens a turn. A blank session holding an entire interview is therefore still blank: navigating away removes it from the session list, and the next New Session reuses it. Nothing is lost — the log is in `$DSH_HOME/sessions` — but the list does not show it. The setup dialog says so when the session you are in is blank.

**Pause** withholds audio from the recognizer without dropping the session — use it while you are the one talking. **Stop** ends the share; the session stays and can be reopened from the session list.

The share picker's audio switch is the browser's, not the plugin's, so a share can arrive without an audio track. That is reported and the session is refused rather than left silently listening to nothing.

If you are sharing your **entire screen** with the other side, this panel is visible to them. Sharing a single window or tab is what keeps it private.

## Latency

Qwen3-ASR does support streaming inference, but only through its vLLM backend, which does not run on macOS. This plugin therefore uses the transformers backend and transcribes whole utterances, which fixes the shape of the delay:

| Stage | Typical |
|---|---|
| Trailing silence before an utterance is considered finished (`vadMinSilenceMs`) | 700 ms |
| Qwen3-ASR on one short utterance | 500–1500 ms |
| First answer token from `ctx.llm` | ~500 ms |

Roughly two to two and a half seconds pass between the counterpart finishing a sentence and the first words of an answer appearing. Lowering `vadMinSilenceMs` shortens that, at the cost of cutting people off mid-sentence when they pause to think. The recognizer process stays resident between utterances so the model load cost is paid once, and is released after `workerIdleShutdownMs` without a session.

A configured deep route moves none of this. Its request starts once the fast one has decided to answer and streams beside it, so the first answer on screen arrives when it always did; the detailed answer lands later, at its own model's pace.

The table covers listening only. Starting carries its own cost: the request that names the session runs to completion first, bounded by `titleMaxOutputTokens` and usually under a second, and the first utterance additionally pays the recognizer process's model load.

## Browser support

Tab-audio capture requires Chrome or Edge; Firefox and Safari do not implement it. Native meeting clients (the Zoom or Tencent Meeting desktop apps) play no audio through any browser tab, so they are out of reach here — capturing those needs a virtual loopback device (BlackHole on macOS, VB-Cable on Windows) selected as an input, which this plugin does not do.

## Configuration

The bundle defaults are in [`cordis.patch.yml`](cordis.patch.yml). A profile override replaces the row's complete `config`, so restate every field the row needs:

```yaml
- id: live-assist
  config:
    localModelPath: /models/Qwen3-ASR-1.7B
    pythonExecutable: /path/to/python3
    localDevice: auto
    language: Chinese
    asrMaxOutputTokens: 256
    vadThreshold: 0.5
    vadMinSilenceMs: 700
    vadSpeechPadMs: 200
    minUtteranceMs: 400
    maxUtteranceMs: 20000
    deepProvider: deepseek-official
    deepModel: deepseek-v4-pro
    deepReasoningEffort: max
    deepMaxOutputTokens: 4096
    deepRequestTimeoutMs: 300000
    answerMaxOutputTokens: 1600
    titleMaxOutputTokens: 64
    answerRequestTimeoutMs: 120000
    maxBackgroundBytes: 32768
    historyTurns: 8
    noteTurns: 6
    maxSessions: 2
    workerIdleShutdownMs: 300000
```

`localModelPath` defaults to `$DSH_HOME/models/Qwen3-ASR-1.7B`. `vadThreshold` is the speech probability above which a 512-sample window counts as speech. `minUtteranceMs` measures speech excluding the padding `vadSpeechPadMs` adds, so a short cough is discarded rather than transcribed. `maxUtteranceMs` cuts a counterpart who never pauses, so an answer is never held back indefinitely. `historyTurns` is how many answered questions ride along as context, and `noteTurns` how many of your own typed messages in the session steer the answers that follow. `titleMaxOutputTokens` caps the one request that names the session. Omitting `answerProvider` and `answerModel` uses the current default Agent route; supply both to pin an independent one. `deepProvider` and `deepModel` turn on the second, detailed answer and must also be given together; `deepReasoningEffort` requires them, and `deepMaxOutputTokens` and `deepRequestTimeoutMs` bound that request alone — a reasoning model needs both to be generous. Omit the pair and no deep request is ever made.

## What is stored

**The interview is recorded in the session log.** Each transcript and each answer is a session event (`live-assist/utterance`, `live-assist/answer-start`, `live-assist/answer-delta`, `live-assist/answer-end`, `live-assist/skipped`), the three answer events naming which track they belong to, so both answers are reconstructed in full and the exchange survives a reload, appears in the session list, and can be reviewed afterwards — which is the point of putting it in a session at all. It is written wherever the deployment's session persistence writes, under `$DSH_HOME/sessions` by default.

Audio is not stored. It is decoded in memory and handed to the model as an array; no recording is ever written. The background material lives in the browser's own local storage and is sent to this machine only.

Two consequences worth knowing before you use it on a real interview:

- Anything the counterpart says is on disk in plain text until you delete that session.
- These event types are contributed by this optional bundle. A build without it installed refuses to reconstruct a session containing them, so removing the plugin makes past interview sessions unreadable rather than merely unrendered. This follows the same rule as every other optional plugin's events (`tool-workflow`, `web-search`).

## HTTP surface

One WebSocket route, `/live-assist/socket`, registered as an upgrade route on the Host web server. The upgrade is refused unless the `Host` header names a loopback authority and any browser-supplied `Origin` matches it — a WebSocket upgrade is not covered by CORS, so that check is what stands between a malicious page and this socket's live audio. Binary frames carry little-endian 16-bit mono PCM at 16 kHz; text frames carry the control messages declared in [`src/protocol.ts`](src/protocol.ts).

Transcripts and answers do not travel on this socket. The browser names the session carrying the interview in its `start` message, and the Host appends every result to that session, so the conversation is their single source and a reload loses nothing.

## Tests

The TypeScript half is covered by the repository's `pnpm run test` lane. The worker's utterance-segmentation logic is tested separately in [`python/test_segmenter.py`](python/test_segmenter.py) against a scripted stand-in for silero-vad; those tests need only numpy and are not part of the repository's test lane:

```bash
python3 -m pytest packages/meeting/live-assist/python
```

## Model Experience

### Suggested answer for one counterpart utterance

#### What the model sees

One request per utterance the recognizer judged to be complete. Its system instruction states the leading `SKIP`/`ANSWER` control line and the answer format: a one-line conclusion the interviewee can say out loud, 3 to 5 bullets tying the claim to a real project in the résumé and to the target role's responsibilities, and a closing `延伸：` paragraph with the metrics, trade-offs, or likely follow-up question; its user message is a JSON object carrying the interviewee's background material, the last `historyTurns` answered questions, and the transcribed utterance. The transcript and the background material are both framed as untrusted data and cannot change the instruction hierarchy. Triage defaults to answering: only greetings, bare acknowledgements, the interviewer describing the company or the role, and unintelligible fragments are skipped, and a follow-up on a topic already answered is always answered, going deeper than the previous turn. Nothing about the panel, the socket, or the recognizer appears in the request.

#### Token effect

Each utterance is one independent auxiliary request on this track; a meeting produces roughly one per question asked. Output is capped by `answerMaxOutputTokens`, and an utterance the model triages as `SKIP` stops after a single token. Input grows with the background material, which `maxBackgroundBytes` bounds, and with `historyTurns`. Capture, segmentation, and recognition have no LLM token effect.

#### KV Cache effect

Answer requests are independent of the Agent conversation and of one another. The system instruction is identical across a session and may be provider-cacheable, but the user message changes with every utterance and every appended history turn, so the cacheable prefix ends before it. Provider cache availability and eviction remain outside this package.

### Detailed answer for the same utterance

#### What the model sees

One request against the configured deep route, made only for an utterance the fast track already decided to answer, and not made at all without `deepProvider` and `deepModel`. Its system instruction states that triage has already happened, so there is no control line to emit, and asks for five named sections: the direct answer, the mechanism behind the question, the matching experience from the résumé as situation-task-action-result, where the approach stops holding and what it trades against, and the two or three follow-ups the interviewer is most likely to ask. Its user message is the same JSON object the fast request was given — background material, the history as it stood when the question was asked, the interviewee's typed notes, and the utterance — and the transcript and the material are framed as untrusted data here too. Neither track sees the other's answer.

#### Token effect

A configured deep route roughly doubles the requests an interview makes and more than doubles its output tokens: `deepMaxOutputTokens` defaults to 4096 against `answerMaxOutputTokens`'s 1600, and a reasoning model bills its thinking on top of that. The input is the fast track's input again, so the background material and `historyTurns` are paid for twice per answered question. An utterance triaged as `SKIP` costs nothing here, because no deep request is made for it.

#### KV Cache effect

The deep request is independent of the fast one, of the Agent conversation, and of every other deep request. Its system instruction is identical across a session and may be provider-cacheable, but the user message changes with every utterance, so the cacheable prefix ends before it, exactly as on the fast track.

## Known Limitations and Deferred Work

- Answer latency is bounded from below by whole-utterance recognition, as described above; it is not a live captioning experience.
- Only Chromium-family browsers can share tab audio, and only browser-based meetings are reachable.
- Recognition quality follows Qwen3-ASR on short segments: a crosstalk-heavy panel interview transcribes worse than one person asking one question at a time.
- The Host holds one model in device memory per plugin. Running this bundle alongside `dsh-meeting-minutes` loads the weights twice.
- A session carrying this plugin's events cannot be reconstructed by a build without the plugin, as described under What is stored above. `Session.append` exposes no way to mark an event ignorable, so this is not something the plugin can opt out of today.
- The answer stream is written to the log one delta at a time, mirroring `assistant/chunk`. A long interview therefore produces a log dominated by answer fragments.
- Answers are serialized, so a burst of questions makes the later answers late. Nothing merges an utterance the recognizer split mid-sentence, so a trailing fragment is answered as its own question; raising `vadMinSilenceMs` is the blunt way to reduce that.
- A configured deep route doubles the model requests an interview makes, and its answers queue on a track of their own: three questions in a row make the third detailed answer late even though its short answer arrived on time.
- Naming needs a `sessionTitle` service. Without one the session keeps its default name, and no title request is made.
- Nothing this plugin appends clears a session's blank bit, which is derived from `turn/start` alone. An interview recorded in a blank session stays out of the session list and is reused by the next New Session; the dialog warns, but the fix would be a session-vocabulary change beyond this bundle.
