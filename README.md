# DeepSeek Harness meeting plugins

English | [中文](README.zh.md)

Two optional Web profile bundles under [`packages/meeting/`](packages/meeting/README.md) turn meeting audio into text on your own machine: [`meeting-minutes`](packages/meeting/meeting-minutes/README.md) records or ingests a whole meeting and publishes Markdown minutes, and [`live-assist`](packages/meeting/live-assist/README.md) listens to a call while it happens and streams a suggested answer for each question the counterpart asks. Both transcribe through a local Qwen3-ASR model, summarize or answer through the harness's own `ctx.llm` route, and install into the existing `web` profile without modifying `agent-loop` or the shipped profile.

## Run

Install `Node.js`, then start the Web application:

```bash
npx @deepseek-ai/dsh web
```

The command serves the Web UI at `http://127.0.0.1:3080` by default. Both meeting bundles are installed from a checkout of this repository, so every step below assumes the source path.

### Run from source

```bash
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
```

`pnpm dsh web` then starts the same Web application from that checkout. Each bundle's own install command is in its section below.

### Python dependencies and the ASR model

Install the Python packages into the interpreter you name as `pythonExecutable`. `qwen-asr` alone covers `meeting-minutes`; `live-assist` also needs `silero-vad`:

```bash
python3 -m pip install -U qwen-asr silero-vad
```

Download the complete [Qwen3-ASR-1.7B](https://huggingface.co/Qwen/Qwen3-ASR-1.7B) model directory. One weight shard is not a runnable model:

```bash
python3 -m pip install -U huggingface_hub
hf download Qwen/Qwen3-ASR-1.7B --local-dir "$HOME/.dsh/models/Qwen3-ASR-1.7B"
```

Both plugins check that directory's file list before registering any route, and both may share one directory — each still holds its own copy of the weights in device memory. `localDevice: auto` tries CUDA, then Apple MPS, then CPU.

### Browser support

Recording the computer's own audio and capturing a tab's audio are Chromium-family features: use Chrome or Edge. Firefox and Safari implement neither.

## `meeting-minutes` — a recorded meeting becomes Markdown minutes

### What it does

- Records the microphone in the browser, optionally summed with the computer's own audio output, or takes an existing MP4 upload.
- Streams the original to private storage, transcodes it to MP4/AAC unless it already is MP4, and transcribes sequential 16 kHz mono chunks through Qwen3-ASR.
- Summarizes the full transcript through `ctx.llm`, reducing a transcript too long for one request through bounded rounds, and publishes dated Markdown carrying the topic, the minutes, and the whole transcript.
- Keeps a meeting history you can reopen, reprocess from the preserved original, download from, or delete.
- Contributes its own card to the plugin configuration page, so the storage directory and the ASR route are editable without touching YAML.

### Install and run

```bash
pnpm dsh plugin --profile web add ./packages/meeting/meeting-minutes
pnpm dsh web
```

The install changes only `$DSH_HOME/profiles/web/package.json` and its dependencies. Remove it with `pnpm dsh plugin --profile web remove @deepseek-ai/dsh-meeting-minutes`.

### Use it

1. Open the **Meeting minutes** control in the composer. It opens on the stored meeting history.
2. Choose the microphone — **Same device as the system** by default, or **No microphone** — and turn on **Also record computer audio** when the remote voices come from a native meeting client no browser tab can reach.
3. Start recording. With computer audio enabled the browser asks for a screen share: pick any window or the whole screen, turn on the picker's own system-audio switch, and keep the share open for the whole meeting. Only audio is recorded, the shared video is never read, and a share arriving without an audio track is refused rather than silently kept as a microphone-only recording that is missing every remote voice.
4. Stop the recording, or upload an existing MP4 instead. Processing runs through normalization, ASR, and summary, one meeting at a time.
5. Download the preserved original, the plain-text transcript, or the finished Markdown. **Process again** reruns a complete or failed meeting from its preserved original.

Wear headphones: speakers plus an open microphone make the room hear itself.

One recording produces `metadata.json`, the preserved original, `audio.mp4` when the original was not MP4, `transcript.json`, `transcript.txt`, `summary-requests.json`, and `YYYY-MM-DD_HH-mm_<topic>_<minutes>m.md`, all under `$DSH_HOME/meeting-minutes/<meeting-id>/` with owner-only permissions. The route family `/meeting-minutes/api` accepts only loopback Host values and same-origin browser requests, so a Web GUI reached through a LAN address cannot use this plugin.

## `live-assist` — a live call gets suggested answers

### What it does

- Captures the audio of one shared browser tab and streams 16 kHz PCM to the Host over a loopback WebSocket. It never opens a microphone.
- Segments that audio with silero-vad, transcribes each completed utterance through a resident local Qwen3-ASR process, and judges whether the utterance is a question at all.
- Streams a suggested answer through `ctx.llm`, carrying the background material you pasted in and the last few answered questions as context.
- Appends every transcript and every answer to the session you started from, so the exchange survives a reload and can be reviewed afterwards. Audio is never written to disk.

### Why only the counterpart is transcribed

The separation is physical rather than statistical: the counterpart's voice is played by the meeting page and lands in the captured tab audio, while your own voice goes from your microphone to the meeting client's uplink and never reaches the tab's output. No speaker diarization is involved, and none is needed.

### Install and run

```bash
pnpm dsh plugin --profile web add ./packages/meeting/live-assist
```

**Configure it before starting.** The plugin validates its model directory while the plugin tree loads, so a `localModelPath` that is not a complete model directory fails the whole application's startup, not just this bundle. Unless the model really sits at `$DSH_HOME/models/Qwen3-ASR-1.7B` and `python3` on `PATH` has both Python packages, add a `live-assist` row to `$DSH_HOME/profiles/web/cordis.patch.yml` naming your own paths, then start the Web application:

```bash
pnpm dsh web
```

Remove it with `pnpm dsh plugin --profile web remove @deepseek-ai/dsh-live-assist`.

### Use it

1. Open the **Interview assist** control in the composer and paste your background material — résumé, target role, projects worth emphasizing. It is kept in browser storage and sent to this machine only.
2. Press **Start listening**. Listening happens in the session you have open, and no other session is created. For an interview in a session of its own, create one first and send a message in it: nothing this plugin appends clears a session's blank bit, so a blank session holding a whole interview stays out of the session list.
3. In the browser's share picker choose the **tab** running the meeting, turn on *Share tab audio*, and keep the share open for the whole call. Sharing your entire screen makes this panel visible to the other side; sharing one tab is what keeps it private.
4. Your material arrives in the conversation first, in full, and the session is named from it before listening starts. Each thing the counterpart then says arrives as a message with its suggested answer beneath it.
5. **Pause** withholds audio from the recognizer while you are the one talking. **Stop** ends the share; the session stays and can be reopened from the session list.

Every utterance gets its own answer, generated one at a time in the order the questions were heard, so a burst of questions makes the later answers late. Wear headphones: through speakers the meeting client's echo cancellation reacts to the room and degrades what the recognizer receives.

### Latency and what is stored

| Stage | Typical |
|---|---|
| Trailing silence before an utterance is considered finished (`vadMinSilenceMs`) | 700 ms |
| Qwen3-ASR on one short utterance | 500–1500 ms |
| First answer token from `ctx.llm` | ~500 ms |

Roughly two to two and a half seconds pass between the counterpart finishing a sentence and the first words of an answer appearing. Starting carries its own cost: the request that names the session runs to completion first, and the first utterance additionally pays the recognizer process's model load.

Each transcript and each answer is a session event, written wherever the deployment's session persistence writes, under `$DSH_HOME/sessions` by default. Two consequences are worth knowing before a real interview: anything the counterpart says is on disk in plain text until you delete that session, and a build without this bundle installed refuses to reconstruct a session containing these events.

## Configuration

Each bundle's defaults live in its own `cordis.patch.yml`. A profile override in `$DSH_HOME/profiles/web/cordis.patch.yml` replaces the row's complete `config`, so restate every field the row needs; the complete example rows are in [`meeting-minutes`](packages/meeting/meeting-minutes/README.md) and [`live-assist`](packages/meeting/live-assist/README.md), which also document every field, the HTTP surfaces, and the known limitations.

The fields most deployments change are `localModelPath`, `pythonExecutable`, `localDevice`, and `language` for both bundles; `storageRoot`, `asrChunkSeconds`, and the `asrMode: remote` endpoint fields for `meeting-minutes`; and `vadMinSilenceMs`, `historyTurns`, and `answerMaxOutputTokens` for `live-assist`. Omitting the `summaryProvider`/`summaryModel` and `answerProvider`/`answerModel` pairs uses the current default Agent route; supplying both fields of a pair pins an independent route.

`meeting-minutes` additionally edits `storageRoot`, `asrMode`, `language`, `localModelPath`, `pythonExecutable`, `localDevice`, `remoteEndpoint`, and `remoteModel` from its settings card. A field left empty there re-inherits the composition layer, a save is refused when the resolved section is one the plugin could not run, and an accepted save rebuilds the route, the runtime, and the ASR worker at once.

## License

[MIT](LICENSE). Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
