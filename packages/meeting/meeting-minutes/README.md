# @deepseek-ai/dsh-meeting-minutes

English | [中文](README.zh.md)

Optional Web profile bundle for browser-recorded meeting minutes. Its browser half contributes a card to the plugin configuration page, opens on the stored meeting history, records the microphone — optionally mixed with the computer's own audio output — or uploads an existing MP4, shows progress, reprocesses a stored meeting, and downloads the preserved original, the plain-text transcript, or the completed Markdown; its Host half streams the original upload to private storage, transcodes it to MP4/AAC unless it already is MP4, transcribes sequential 16 kHz mono WAV chunks through Qwen3-ASR-1.7B, and summarizes the full transcript through `ctx.llm`. It does not modify `agent-loop` or the shipped Web profile.

## Install

Build this checkout, install the bundle into the `web` profile, then start the existing Web application:

```bash
pnpm run build
pnpm dsh plugin --profile web add ./packages/meeting/meeting-minutes
pnpm dsh web
```

The install changes only `$DSH_HOME/profiles/web/package.json` and its dependencies. Remove it with:

```bash
pnpm dsh plugin --profile web remove @deepseek-ai/dsh-meeting-minutes
```

`$DSH_HOME/settings.yaml` is unrelated to this plugin's composition settings. The standard settings provider creates that file lazily when a settings write needs it; its absence does not prevent this bundle from loading. Configure meeting minutes through the profile's `$DSH_HOME/profiles/web/cordis.patch.yml`, which overrides the bundle row.

## Local Qwen ASR

Install `qwen-asr` into the Python environment named by `pythonExecutable`:

```bash
python3 -m pip install -U qwen-asr
```

Download the complete [Qwen3-ASR-1.7B](https://huggingface.co/Qwen/Qwen3-ASR-1.7B) model directory. One weight shard is not a runnable model:

```bash
python3 -m pip install -U huggingface_hub
hf download Qwen/Qwen3-ASR-1.7B \
  --local-dir "$HOME/.dsh/models/Qwen3-ASR-1.7B"
```

The plugin checks these files before registering any HTTP route:

```text
config.json
generation_config.json
chat_template.json
preprocessor_config.json
tokenizer_config.json
vocab.json
merges.txt
model.safetensors.index.json
model-00001-of-00002.safetensors
model-00002-of-00002.safetensors
```

The Python process starts lazily on the first ASR chunk and retains the model for later chunks and meetings. It holds the whole model in device memory, so it is terminated once no chunk has been outstanding for `asrIdleShutdownMs` (two minutes by default); the next chunk starts it again and pays the load cost once more, so raise the value on hosts where loading is slow and lower it to release accelerator memory sooner. It loads the Hugging Face model files directly through `qwen-asr`; Ollama is not in this local inference path. `localDevice: auto` tries CUDA, then Apple MPS, then CPU. An accelerator load failure may fall back to CPU only in `auto` mode; local ASR never falls back to the remote endpoint. Qwen's upstream examples primarily target CUDA, so verify MPS throughput and memory with a short recording before relying on a long meeting.

## Configuration

The bundle defaults are in [`cordis.patch.yml`](cordis.patch.yml). A profile override replaces the row's complete `config`, so restate every field the row needs:

```yaml
- id: meeting-minutes
  config:
    storageRoot: /private/meeting-minutes
    asrMode: local
    localModelPath: /models/Qwen3-ASR-1.7B
    pythonExecutable: /path/to/python3
    localDevice: auto
    language: Chinese
    asrChunkSeconds: 300
    asrRequestTimeoutMs: 1800000
    asrIdleShutdownMs: 120000
    asrMaxOutputTokens: 2048
    remoteEndpoint: http://127.0.0.1:8000/v1/chat/completions
    remoteModel: Qwen/Qwen3-ASR-1.7B
    remoteApiKeyEnv: QWEN_ASR_API_KEY
    summaryMaxInputBytes: 65536
    summaryMaxOutputTokens: 4096
    summaryMaxReductionRounds: 8
    summaryRequestTimeoutMs: 600000
    maxUploadBytes: 2147483648
    listMaxMeetings: 200
    timeZone: Asia/Shanghai
```

`storageRoot` defaults to `$DSH_HOME/meeting-minutes`; `localModelPath` defaults to `$DSH_HOME/models/Qwen3-ASR-1.7B`; `listMaxMeetings` caps the newest meetings the history list returns; `timeZone` defaults to the Host process time zone. Omitting `summaryProvider` and `summaryModel` uses the current default Agent route. Supply both fields to pin an independent summary route. `ffmpegExecutable` may override the package-local FFmpeg binary.

For a remote Qwen ASR server, set `asrMode: remote`, keep the complete endpoint and model fields, and name the environment variable containing its optional bearer token. The request uses the OpenAI-compatible `/v1/chat/completions` audio-content form supported by `qwen-asr-serve`/vLLM. A remote failure stops the meeting; it never starts local inference automatically.

## Settings card

The bundle registers the `meeting-minutes` settings namespace and its own card in the plugin configuration page, so the storage directory and the ASR route are editable without touching `cordis.patch.yml`. The card edits `storageRoot`, `asrMode`, `language`, `localModelPath`, `pythonExecutable`, `localDevice`, `remoteEndpoint`, and `remoteModel`; every other field stays composition-only.

A field left empty re-inherits the composition layer, and a save is refused when the resolved section is one the plugin could not run — an `asrMode: local` section naming an incomplete model directory reports the missing files instead of storing a value that would fail at the next start.

An accepted save replaces the running installation at once: the route, the processing runtime, and the persistent ASR worker are torn down and rebuilt from the new configuration. A meeting still being processed is aborted and recorded as failed, exactly as a plugin reload leaves it; stored recordings, transcripts, and minutes are untouched. A save that resolves to the running configuration installs nothing.

The card renders only where the settings surface is mounted and the Host serves the namespace, so a deployment without the plugin configuration page still gets the recorder.

## Choosing audio sources

The recorder's two controls choose what one recording captures. The microphone dropdown offers **Same device as the system** — the default, which follows whatever the operating system currently uses — **No microphone**, and every microphone the browser reports. Device names are visible only after microphone access has been granted once, so the dropdown asks for access the first time it is opened; declining leaves the two fixed entries. A stored selection whose device is gone falls back to the system device. Both controls are remembered in browser storage for the next recording.

Selecting **No microphone** without computer audio leaves nothing to record, so recording is refused until one source is selected.

## Recording computer audio

The recorder captures the microphone alone by default. Enabling **Also record computer audio** before starting makes the browser additionally request a screen share whose system audio is captured, and the two sources are summed into the single audio track `MediaRecorder` writes. Everything the machine plays — including native meeting clients that no browser tab can reach — is recorded alongside the room, or on its own when no microphone is selected.

Using it: start the recording, pick any window or the whole screen in the browser's picker, and turn on the picker's own system-audio switch. The share must stay open for the whole meeting, because the shared video track carries the audio; the plugin never records the video. Ending the share from the browser's banner stops the recording and submits what it captured.

The picker's system-audio switch is the browser's, not the plugin's, so a share can arrive without an audio track. That is reported and the recording is refused rather than silently kept as a microphone-only recording that is missing every remote voice. Speakers plus an open microphone also make the room hear itself: microphone echo cancellation stays on, and headphones remain the reliable answer.

Availability is the browser's: Chrome and Edge offer the switch, macOS support arrived with Chrome's ScreenCaptureKit capture, Windows offers it for whole-screen shares, and Firefox and Safari do not implement it at all. Where the switch is absent, a virtual loopback device selected as the microphone is the remaining option.

## Files and HTTP access

One recording produces:

```text
<storageRoot>/<meeting-id>/
├── metadata.json
├── original.<browser-format>
├── audio.mp4                 # only when the original is not MP4
├── transcript.json
├── transcript.txt
├── summary-requests.json
└── YYYY-MM-DD_HH-mm_<model-topic>_<minutes>m.md
```

Files and directories are created with owner-only permissions. An MP4 original is its own playback file: FFmpeg transcodes only another container, so `audio.mp4` exists only then. The Markdown links to the preserved browser recording, adds an `audio.mp4` link only when that transcoded file exists, then contains the generated minutes and the full, non-speaker-attributed transcript. The filename carries the meeting date, its start time, the model topic, and its recorded length rounded up to whole minutes and never below one. Topic path characters are replaced, the filename topic is limited to 40 Unicode characters, `未命名会议` is used only when no usable topic remains, and a short meeting id is appended on collision.

The route family is `/meeting-minutes/api`. It accepts only loopback Host values and same-origin browser requests, so a Web GUI reached through a LAN address cannot use this plugin. This is a DNS-rebinding and cross-site request fence, not user authentication. Uploads stream directly to disk and stop at `maxUploadBytes`; original and normalized audio responses support byte ranges.

| Method and path | Purpose |
|---|---|
| `GET /meetings` | Newest-first history rows: id, stage, display name, and creation instant |
| `POST /meetings` | Stream one recording or selected file; `x-meeting-source-filename` carries a percent-encoded display name |
| `GET /meetings/<id>` | Stage, progress, transcript, summary, and artifact availability |
| `DELETE /meetings/<id>` | Permanently remove one meeting directory and every artifact in it |
| `POST /meetings/<id>/retry` | Reprocess a complete or failed meeting from its preserved original |
| `GET /meetings/<id>/original` | Download the preserved browser recording |
| `GET /meetings/<id>/audio` | Play or download the MP4 playback file |
| `GET /meetings/<id>/transcript` | Download the plain-text transcript under the published minutes name |
| `GET /meetings/<id>/minutes` | Download the final Markdown |

A history row is named by its final Markdown filename once summarized, then by the uploaded filename, then by the stored recording filename. An uploaded name is display-only metadata: it never selects a path, and the stored file keeps the fixed name derived from its media type. A record left nonterminal by a Host restart is listed as failed before any read republishes it.

## Lifecycle

Deleting a meeting removes its whole directory, including the preserved original recording; it is refused while the processing queue owns that meeting, and the browser asks for a second click before sending it. Only one meeting runs through normalization, ASR, and summary at a time. A retry is accepted only for an inactive meeting whose durable stage is `complete` or `failed`; it preserves the original upload, clears derived metadata, and reruns normalization, ASR, and summary from the beginning. Reprocessing a complete meeting overwrites any transcoded MP4, the transcript, and the summary audit, and leaves the previous topic's Markdown in the directory while metadata points only at the new artifacts. Concurrent retries for the same meeting return a conflict, and retry never changes the configured local or remote ASR destination. Plugin disposal removes the route first, aborts active request bodies and model calls, terminates the persistent Python process, and waits for retry admission and the complete task chain. A nonterminal metadata record observed after a Host restart becomes a durable failed record that can be retried.

## Model Experience

### Hierarchical meeting summary

#### What the model sees

The configured summary route receives the full transcript when it fits `summaryMaxInputBytes`. Longer transcripts are divided into bounded parts, reduced through Markdown summaries, then sent to one final JSON request for `topic` and `summaryMarkdown`. Each exact system instruction, input, route, limit, and output is persisted in `summary-requests.json`; the transcript is framed as untrusted data and cannot change the instruction hierarchy.

#### Token effect

Each summary is an independent auxiliary model request. The number of calls grows with transcript length; every input is capped by `summaryMaxInputBytes` and every output by `summaryMaxOutputTokens`. A reduction round must make the combined input smaller, and processing fails after `summaryMaxReductionRounds` rounds instead of continuing indefinitely with an unsuitable model. Recording, normalization, and ASR have no direct LLM token effect.

#### KV Cache effect

Summary requests are independent of the Agent conversation and of one another. Their stable system prefixes may be provider-cacheable, but data-dependent transcript or reduction content changes the user-message suffix; provider cache availability and eviction remain outside this package.

## Known Limitations and Deferred Work

- **No speaker diarization** — every transcript is plain meeting text; the plugin never invents speaker identities.
- **Coarse timestamps only** — transcript timestamps mark fixed ASR chunk starts. Phrase- or word-level alignment requires a separate forced-aligner model and is not implemented.
- **Loopback browser only** — the raw upload and download routes intentionally reject LAN Host values until the Web surface has an authentication layer or exposes a reusable authenticated route helper.
- **No mid-stage resume** — retry reuses the retained original recording but restarts normalization, ASR, and summary instead of continuing from a completed chunk or summary request.
- **System audio depends on the browser** — the plugin can only ask for a share with audio. Firefox and Safari never provide it, and older Chrome builds provide it only on Windows and ChromeOS. There is no Host-side capture path that would work without a browser share or a virtual loopback device.
- **The share stays visible while recording** — capturing computer audio keeps a screen share alive for the whole meeting, so the browser shows its sharing banner and the operating system shows its sharing indicator. Only audio is recorded; the shared video is never read.
- **Platform model variance** — Qwen3-ASR upstream support and performance vary across CUDA, MPS, and CPU. The package validates files and reports runtime failures but cannot guarantee accelerator compatibility.
