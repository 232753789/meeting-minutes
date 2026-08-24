# Agent Note: Meeting minutes resume at the stage that failed

Status: implemented

English | [中文](2026-08-23-meeting-minutes-resume-at-the-failed-stage.zh.md)

## Problem

Retrying a meeting reran the whole chain from the preserved recording: transcode, every ASR chunk, every summary request. That is the wrong price for the failures that actually happen.

The work is heavily back-loaded. A 90-minute meeting is 18 five-minute chunks through a 1.7B model, and the summary of a long transcript is a dozen sequential LLM calls. The failures that end a run — one remote ASR call timing out, the summary route being briefly unavailable, a final JSON object that does not parse, a Host restart mid-transcription — arrive after most of that work succeeded. Retrying threw all of it away and paid for it again, and a route that fails intermittently could lose an afternoon to repeated full reruns.

Nothing was retained to do better. `completedChunks` recorded how far ASR had got, but the chunk texts themselves lived in an in-memory array that died with the attempt, so even a run that failed on the last chunk had no transcript to show for it.

## Decision

Processing is idempotent, and a retry decides only how much of the previous attempt survives to feed it.

`process()` resumes from whatever the meeting directory holds, whether it is the first attempt or the fifth. A published transcript skips normalization and ASR entirely. Otherwise the WAV chunks are cut again — they are temporary and cheap next to inference — and the chunks a previous attempt finished are read back from `transcript-progress.json` instead of being sent to the model again. A playback file a previous attempt transcoded is reused when it is still on disk, because `normalizedAudio` is published only after transcoding returned.

`transcript-progress.json` is the new durable artifact: `{ chunkSeconds, segments }`, rewritten after each chunk and deleted once `transcript.json` is published. It is written before the record's `completedChunks`, so a crash between the two leaves progress ahead of the record rather than transcript text the next attempt would drop. It is discarded when its `chunkSeconds` or its length no longer lines up with the chunks this attempt will transcribe, which is what makes a changed `asrChunkSeconds` safe.

Summaries reuse `summary-requests.json`, which already persisted each request and its output for audit. Reduction is deterministic in the transcript, so request *n* repeats exactly until the position the previous attempt stopped at: reuse is position-based and ends at the first position whose system instruction or input differs. `readSummaryRequests` returns only the leading run of requests that carry an output — the audit is written in dispatch order, so the first one without an output is where the attempt stopped. The request producing the final JSON is never reused: its output is the one that still has to parse, and a persisted output that failed to parse would otherwise be replayed on every attempt.

`MeetingRetryMode` is the wire vocabulary. `POST /meetings/<id>/retry` resumes by default and restarts on `?mode=restart`; any other value is a 400. Restart is not a separate code path — it deletes the progress and audit files and clears the derived metadata, after which the same idempotent `process()` starts over.

`resumeStage(record)` is the single judgement behind both the offer and the act. The status projection publishes it as `resumeFrom` (`summarizing` once the transcript is published, `transcribing` once the recording is transcoded or any chunk is done, absent otherwise) and `admitRetry` consults the same function, so the button the browser shows and the work the Host skips cannot disagree. It answers only for a failed meeting: a complete one has no failed stage, so asking it to resume reprocesses it in full.

The browser offers both when there is something to keep — **继续解析** as the primary action, **重新解析** beside it — and only the full reprocess otherwise.

## Alternatives considered

**Keep the WAV chunks between attempts.** They are the one input a resumed ASR pass needs, so retaining them looks like the obvious saving. Rejected on cost and fragility: 16 kHz mono PCM is ~115 MB per hour of meeting, which would sit in the directory for every meeting that ever failed, and a chunk directory left half-written by a crash would need its own validation. Re-cutting is one deterministic FFmpeg pass whose cost disappears next to the inference it protects.

**Append completed segments to `transcript.json` instead of a separate progress file.** It avoids a file. Rejected because `transcript.json` would then mean either "the transcript" or "part of one" depending on a metadata field read separately, and the file has no room for the `chunkSeconds` the alignment check needs. A separate artifact deleted at publication keeps "this file exists" and "transcription is unfinished" the same statement.

**Store the completed segments in `metadata.json`.** No new file, and the record is already rewritten after every chunk. Rejected because that rewrite would grow with the transcript: a three-hour meeting would rewrite hundreds of kilobytes per chunk to record one new segment.

**Match summary requests by content instead of by position.** A hash of system and input would reuse a completed request wherever it appears. Rejected as more machinery for no gain: reduction already produces the same sequence for the same transcript, position-based matching gets the same hits, and content matching would also have to decide what to do about two positions with identical inputs.

**Infer resume from the durable stage the record stopped in.** `stage: 'transcribing'` implies chunks are done. Rejected because the stage says where the attempt was, not what survived on disk — a `transcribing` record whose progress file is gone or misaligned would promise a resume it cannot deliver. The artifacts decide.

**Make restart the default and resume the opt-in.** It preserves the previous behavior for callers that send no parameter. Rejected because it defaults to the expensive answer to the common question: a failed meeting is normally retried to get past what failed.

## Consequences

- Bought: a retry priced by what actually failed. A summary route that fails after 18 transcribed chunks now costs the summary alone, and a Host restart mid-transcription resumes at the chunk it reached.
- Cost: one more durable file per unfinished meeting, and a resume whose reuse rules are only as good as the alignment checks — a mis-sized `transcript-progress.json` is discarded rather than trusted.
- A resume can still repeat one unit of work: the chunk or request that failed is redone in full, and the final JSON request is always dispatched again.
- Reprocessing a meeting whose transcript changed pays for every summary request again, because every input differs. This is the correct outcome and the reason reuse compares inputs rather than counting positions.
- `asrChunkSeconds` may be changed between attempts without corrupting a transcript; the misaligned progress is dropped and the meeting is transcribed from the first chunk.

## Testing

`tests/resume.spec.ts` drives the four paths end to end: ASR resumed at the chunk that failed (asserting the completed chunk is never sent to the model twice), a published transcript that skips normalization and ASR, a restart that discards the progress and audit files, and a record left mid-transcription by a Host restart.

`tests/summary.spec.ts` fails one attempt partway through the partial summaries and asserts the next attempt replays exactly the completed ones, that a transcript that changed reuses nothing, and that a final JSON object that failed to parse is requested again rather than replayed.

`tests/config-storage.spec.ts` covers the durable-file boundary: progress that round-trips, and progress or audit files that are unparsable, misaligned, over-long, or unreadable.

`tests/ffmpeg.spec.ts` asserts a previously transcoded playback file is reused and that a missing one is transcoded again. `tests/http.spec.ts` covers the default, both explicit modes, and the rejection of any other value.

## Related

- [Browser meeting minutes](2026-08-19-browser-meeting-minutes.md) — the bundle whose retry this replaces.
