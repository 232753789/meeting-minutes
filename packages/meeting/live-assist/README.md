# @deepseek-ai/dsh-live-assist

English | [中文](README.zh.md)

Optional Web profile bundle for real-time meeting assistance. Its browser half captures the audio of one shared browser tab, streams 16 kHz PCM to the Host over a loopback WebSocket, and renders the counterpart's transcript beside a streamed suggested answer; its Host half segments that audio with silero-vad, transcribes each completed utterance through a local Qwen3-ASR model held in memory, decides whether the utterance is a question at all, and streams an answer through `ctx.llm`. Nothing is written to disk. It does not modify `agent-loop` or the shipped Web profile.

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

1. Open the **Interview assist** control in the composer, and paste your background material — résumé, target role, projects worth emphasizing. It is kept in browser storage and sent to this machine only.
2. Press **Start listening**. A session that already holds a conversation gets a new dsh session first, switched to immediately, so the interview does not land in whatever conversation you had open; a blank session is listened in as it is, because that is the session New Session would land in anyway. In the browser's share picker, choose the **tab** running the meeting and turn on *Share tab audio*. Keep the share open for the whole call.
3. The dialog closes and the composer keeps one compact row: a status dot, what the recognizer is doing, **Pause**, and **Stop**. Everything else is the conversation.
4. Each thing the counterpart says arrives as a message, with the answer suggested for it beneath it. The view scrolls with the newest exchange; scrolling up stops that, exactly as it does for an ordinary conversation.

Every utterance gets its own answer. Answers are generated one at a time in the order the questions were heard, and a newer question never cancels the one being answered — the recognizer splits on silence, so a pause mid-sentence can end an utterance early, and cancelling would throw away the answer to the real question while leaving only the fragment that followed it. The cost is that answers queue: if the counterpart asks three things in a row, the third answer waits for the first two.

The session is named from your background material by the same model route, so it is identifiable in the session list without being opened. Naming does not delay listening — audio flows while the title request is still out, and a session that fails to be named keeps its default name.

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
    answerMaxOutputTokens: 800
    titleMaxOutputTokens: 64
    answerRequestTimeoutMs: 120000
    maxBackgroundBytes: 32768
    historyTurns: 8
    noteTurns: 6
    maxSessions: 2
    workerIdleShutdownMs: 300000
```

`localModelPath` defaults to `$DSH_HOME/models/Qwen3-ASR-1.7B`. `vadThreshold` is the speech probability above which a 512-sample window counts as speech. `minUtteranceMs` measures speech excluding the padding `vadSpeechPadMs` adds, so a short cough is discarded rather than transcribed. `maxUtteranceMs` cuts a counterpart who never pauses, so an answer is never held back indefinitely. `historyTurns` is how many answered questions ride along as context, and `noteTurns` how many of your own typed messages in the session steer the answers that follow. `titleMaxOutputTokens` caps the one request that names the session. Omitting `answerProvider` and `answerModel` uses the current default Agent route; supply both to pin an independent one.

## What is stored

**The interview is recorded in the session log.** Each transcript and each answer is a session event (`live-assist/utterance`, `live-assist/answer-start`, `live-assist/answer-delta`, `live-assist/answer-end`, `live-assist/skipped`), so the exchange survives a reload, appears in the session list, and can be reviewed afterwards — which is the point of putting it in a session at all. It is written wherever the deployment's session persistence writes, under `$DSH_HOME/sessions` by default.

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

One request per utterance the recognizer judged to be complete. Its system instruction states the answer format and the leading `SKIP`/`ANSWER` control line; its user message is a JSON object carrying the interviewee's background material, the last `historyTurns` answered questions, and the transcribed utterance. The transcript and the background material are both framed as untrusted data and cannot change the instruction hierarchy. Nothing about the panel, the socket, or the recognizer appears in the request.

#### Token effect

Each utterance is one independent auxiliary request; a meeting produces roughly one per question asked. Output is capped by `answerMaxOutputTokens`, and an utterance the model triages as `SKIP` stops after a single token. Input grows with the background material, which `maxBackgroundBytes` bounds, and with `historyTurns`. Capture, segmentation, and recognition have no LLM token effect.

#### KV Cache effect

Answer requests are independent of the Agent conversation and of one another. The system instruction is identical across a session and may be provider-cacheable, but the user message changes with every utterance and every appended history turn, so the cacheable prefix ends before it. Provider cache availability and eviction remain outside this package.

## Known Limitations and Deferred Work

- Answer latency is bounded from below by whole-utterance recognition, as described above; it is not a live captioning experience.
- Only Chromium-family browsers can share tab audio, and only browser-based meetings are reachable.
- Recognition quality follows Qwen3-ASR on short segments: a crosstalk-heavy panel interview transcribes worse than one person asking one question at a time.
- The Host holds one model in device memory per plugin. Running this bundle alongside `dsh-meeting-minutes` loads the weights twice.
- A session carrying this plugin's events cannot be reconstructed by a build without the plugin, as described under What is stored above. `Session.append` exposes no way to mark an event ignorable, so this is not something the plugin can opt out of today.
- The answer stream is written to the log one delta at a time, mirroring `assistant/chunk`. A long interview therefore produces a log dominated by answer fragments.
- Answers are serialized, so a burst of questions makes the later answers late. Nothing merges an utterance the recognizer split mid-sentence, so a trailing fragment is answered as its own question; raising `vadMinSilenceMs` is the blunt way to reduce that.
- Naming needs a `sessionTitle` service. Without one the session keeps its default name, and no title request is made.
