# Agent Note: Browser meeting minutes

Status: implemented

English | [中文](2026-08-19-browser-meeting-minutes.zh.md)

## Problem

The Web application needs an optional, local-first path from microphone capture to durable meeting audio, a complete transcript, a summarized record, and a downloadable Markdown file without coupling the workflow to `agent-loop` or changing the shipped Web profile.

## Decision

`@deepseek-ai/dsh-meeting-minutes` is an installable Web profile bundle with a Client recorder and a Host processing runtime. Installation adds one patch row; the shipped Web profile remains unchanged. The plugin stores one private directory per meeting under `$DSH_HOME/meeting-minutes` by default and permits an explicit storage root.

The recorder captures a chosen microphone — the system device, a named device, or none — and optionally sums the system audio of a browser screen share into the same track so native meeting clients are recorded too; both choices persist in browser storage, a selection leaving no audio source refuses to record, a share that arrives without an audio track fails the recording instead of silently keeping a microphone-only capture. The browser uploads its supported recording format after capture. The Host preserves that original, transcodes it to MP4/AAC with the package-local FFmpeg binary unless the upload already is an MP4 container, splits 16 kHz mono WAV chunks from that playback file, transcribes chunks sequentially without speaker attribution, summarizes the full transcript through `ctx.llm`, and publishes `date_start_topic_duration.md`, whose last component is the recorded length rounded up to whole minutes and never below one. The Markdown links the original, adds an `audio.mp4` link only when transcoding produced a separate file, and contains the generated minutes and every transcript chunk with a coarse start timestamp.

The dialog opens on the stored meeting history rather than on an empty recorder. One row names a meeting by its final Markdown filename once summarized, then by the uploaded filename, then by the stored recording filename, and shows the instant its directory was created; opening a row shows that meeting's stage, artifacts, and downloads. The recorder and an MP4 file chooser are the two ways to create a meeting from the list. An opened meeting downloads the preserved original, the plain-text transcript, and the final Markdown, and reprocesses itself; recording again starts from the list instead of from an opened meeting. Each row also deletes its meeting, which removes the whole directory including the preserved original, so the row asks for a second click before sending the request.

A selected file has no recorder timeline, so the browser derives one: the file's last-modified time ends the meeting and its probed media duration starts it. The probe has a fixed deadline because a media element that reports neither metadata nor an error would otherwise stall the upload. The chosen filename travels as percent-encoded display-only metadata and is reduced to one path-free label; the stored file keeps the fixed name derived from its media type, so a browser-supplied name can never select a path.

## Settings section and installation replacement

The bundle registers the `meeting-minutes` settings namespace over its composition entry and contributes its own card to the plugin configuration page, keyed by that namespace. The card lives in this package rather than beside the three shipped cards because the surface's own slot contract is keyed exactly so a plugin can own its card; the client bundle purity gate then rules out importing that package's card chrome, so the card draws its own controls over the settings scope.

An accepted save replaces the running installation rather than waiting for a restart. The resolved configuration is frozen into the processing runtime and the persistent ASR worker, so the replacement is a complete teardown and rebuild of the route, the runtime, and the worker; a meeting still being processed is aborted and recorded as failed, exactly as a plugin reload leaves it. Replacements are serialized and a section resolving to the running configuration installs nothing, so re-reading the document never interrupts a meeting.

A write is validated by the same resolution the Host performs at load, including the complete-local-model check, so a section the plugin could not run is refused at the write instead of stranding the next start.

## ASR routes

Local mode directly loads the complete Hugging Face `Qwen/Qwen3-ASR-1.7B` directory through one persistent `qwen-asr` Python worker. Both safetensors shards and their tokenizer, processor, generation, template, and index files are required before the plugin registers routes. Automatic device selection tries CUDA, MPS, then CPU; a local failure never sends meeting audio to a remote service. The worker holds the whole model in device memory, so it is terminated after `asrIdleShutdownMs` without an outstanding chunk and started again lazily by the next one: the idle window is a deployment trade between reload cost and held accelerator memory, which is why it is a validated configuration field rather than a constant.

Remote mode targets an explicitly configured OpenAI-compatible chat-completions endpoint, model id, and optional bearer-token environment variable. Switching between local and remote ASR is a configuration decision, not an error fallback.

## Summary bounds and durability

Each summary request has input-byte, output-token, timeout, and reduction-round limits. Long transcripts are summarized in bounded parts and reduced hierarchically; every reduction round must decrease the combined input size. The exact auxiliary requests and outputs are written to `summary-requests.json` before the final Markdown is published.

The runtime serializes meetings to limit ASR model memory, streams uploads directly to owner-only files, and retains the original, normalized audio, and completed transcript when a later stage fails. Retry admission synchronously claims a meeting id before reading its record, accepts an inactive durable `complete` or `failed` stage, and allows only one concurrent caller to enqueue it. Deletion claims the id the same way and refuses a meeting the queue owns, so a directory is never removed while FFmpeg, ASR, or summarization is writing into it. Reprocessing a complete meeting is the same full pass: it overwrites the fixed-name normalized audio, transcript, and summary audit, and leaves the previous topic's Markdown in the directory while metadata points only at the new artifacts. An accepted retry preserves the original, clears derived metadata, and reruns normalization, ASR, and summary; it never changes the configured ASR destination. Plugin disposal removes the route, aborts request and model work, terminates the Python worker, and waits for retry admission and owned work to stop. A Host restart marks a nonterminal record failed rather than presenting it as active indefinitely, after which the same retry path applies.

## HTTP access

The list, raw upload, retry, and artifact routes accept loopback Host values and same-origin browser requests only. `GET /meetings` reads every meeting directory, skips a record it cannot parse rather than failing the whole list, and returns the newest `listMaxMeetings` rows ordered by creation instant, because a meeting id orders by recording start and an uploaded older file does not follow that order. `GET /meetings/<id>/original` serves only the Host-selected original filename, `GET /meetings/<id>/transcript` serves the published transcript under the minutes name, `POST /meetings/<id>/retry` returns accepted, missing, or conflict without a read-then-enqueue race, and `DELETE /meetings/<id>` returns deleted, missing, or conflict under the same claim. This limits DNS-rebinding and cross-site access but is not user authentication, so LAN use remains unavailable until the Web application provides an authenticated route mechanism.

## Alternatives considered

**Add the feature to the shipped Web bundle.** This would impose model files, FFmpeg, storage, and recording UI on users who do not need meeting processing. The feature remains an opt-in bundle.

**Run local Qwen3-ASR through Ollama.** The selected Hugging Face model is distributed for the `qwen-asr` runtime and requires both safetensors shards plus companion files. Direct loading preserves the upstream inference API; remote OpenAI-compatible serving remains a separate mode.

**Accept one safetensors shard.** A shard is not a complete checkpoint. Load-time validation rejects the incomplete directory and names every missing file.

**Transcode in the browser.** Browser codecs and long-recording memory behavior vary. The Host owns one FFmpeg path so stored MP4 and ASR WAV inputs are consistent.

**Ship a Chrome extension for system audio.** `chrome.tabCapture` and `chrome.desktopCapture` reach the same capture pipeline as `getDisplayMedia`, so an extension gains no audio a page cannot already request, while adding a separate distributable, an install flow, and a page-to-extension transport.

**Name the microphones without asking for access.** `enumerateDevices` returns empty labels until microphone access is granted once, so an unnamed list would make the first choice guesswork. Access is requested when the dropdown is first opened, which is the moment the names are needed, rather than when the dialog opens to show history.

**Fall back to a microphone-only recording when a share carries no audio.** The remote half of a meeting is exactly what such a recording would lose, and the loss is invisible until the minutes come back wrong. The recording is refused with the switch to enable named in the message.

**Re-encode every upload to a fixed `audio.mp4`.** An MP4 upload already is the playback container, so re-encoding costs a full pass over long audio and loses quality for nothing. Only another container is transcoded; metadata records which file plays, and the ASR chunks are cut from it either way.

**Fall back from local to remote ASR automatically.** Meeting audio may be confidential. A local failure is reported without changing the configured data destination.

**Store an uploaded file under its browser-supplied name.** A browser filename is attacker-influenced input. It is kept as display-only metadata while the stored file keeps the media-type-derived fixed name, so the history list stays readable without giving the browser any path choice.

**Keep the meeting end time in the Markdown filename.** The start time and the end time answered the same question twice, and a reader comparing two files wanted to know how long each meeting ran. The last component is now the length in whole minutes; a length under one minute is written as `1m` rather than `0m`, which would read as a defect.

**Delete only the generated artifacts and keep the original recording.** The largest file in a meeting directory is the original upload, so keeping it would leave the disk cost the user wanted to reclaim. Deletion removes the directory, and the confirmation click is what protects against a misclick.

**Ship the card beside the three first-party plugin cards.** That would reuse the card chrome, the field controls, and the staged-form model instead of restating them. It would also put an optional bundle's copy and controls in a package every deployment loads, and invert the ownership its slot contract is keyed for. The card is small enough to own; the shared machinery is not reachable from a plugin bundle in any case.

**Apply a saved section at the next restart.** Marking the namespace `restart` would leave the runtime and the ASR worker untouched, at the cost of a card whose fields quietly do nothing until someone restarts the Host. Replacing the installation makes the save mean what it says, and the card names the one consequence — an interrupted meeting — before the user commits.

**Probe an uploaded file's duration on the Host.** FFmpeg could measure it exactly, but only after the upload completes, which would either delay the `202` response or require rewriting the start time after the record is published. The browser already holds the file and reports the same duration before the request starts.

## Verification

Package tests cover configuration, complete-model validation, filename and Markdown rendering, history ordering with unreadable records skipped, display-name reduction, HTTP trust, upload limits, list and transcript routes, original download, single-admission retry from both terminal stages, deletion of a stored meeting and its refusal while queued, filename duration rounding, serialized processing, retry teardown, the upload duration probe including its deadline, client recording and history interaction, the settings section's storage-root replacement and its refusal of an unrunnable section, installation replacement and release, the settings card's staged save and clear, summary convergence, and real Loader composition. The Web snapshot suite mounts the built Client bundle and records the completed result, the failed-to-retried UI, opening a meeting from the history list with its per-row delete state, and a file upload whose timestamps come from the probed duration. A live local-model smoke remains environment-dependent because Qwen3-ASR accelerator support, memory, and throughput vary by host.

## Consequences

The workflow is isolated to one optional package and uses existing Web, subprocess, default-model, and LLM services. The repository additionally registers the package in Host and Client compiler aggregates, permits the reviewed FFmpeg install script, and owns one Web assembled snapshot. A large store makes the history list read every meeting directory per request, which `listMaxMeetings` bounds in the response but not in the read. Local deployments must provide Python with `qwen-asr` and a complete model directory, and they must validate accelerator capacity before processing long meetings.
