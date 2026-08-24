# Agent Note: Context-aware interview questions and optional meeting speaker diarization

Status: implemented

English | [中文](2026-08-24-meeting-question-context-and-speaker-diarization.zh.md)

## Problem

Silence-based VAD endpoints can split one interview question after a connective, causing the answer triage model to receive a fragment and the completed question as separate requests. Meeting minutes can transcribe mixed microphone and computer audio, but fixed-duration chunks do not identify which person spoke each segment.

## Decision

Live assist keeps VAD as its acoustic endpoint and adds a deterministic `QuestionAccumulator` after ASR. It joins fragments ending in configured continuation phrases, releases text with question or sentence boundaries, and splits explicit multiple-question markers before one existing answer-triage request per stable question. The accumulator does not make a second model request, and session teardown does not flush pending text after the socket closes because teardown aborts model work.

Meeting minutes adds an optional `speakerMode: pyannote` path. A persistent Python worker loads a local `pyannote.audio` pipeline, diarizes the normalized recording once, and returns ordered `speaker-1`-style intervals. FFmpeg cuts one temporary mono WAV for each interval, the existing Qwen ASR path transcribes those files, and transcript JSON, plain text, and Markdown retain the interval times and speaker labels. The default `speakerMode: off` retains fixed-duration chunks and does not require pyannote.

Speaker labels are local to one recording. They are not names, persistent voice identities, or cross-meeting profiles. Diarization configuration validates the local pipeline directory at load time, and a diarization failure fails the meeting rather than publishing unlabeled output.

## Alternatives considered

**Send every VAD fragment directly to the existing triage model.** Rejected because the model cannot reliably reconstruct a question from a fragment that is already presented as a complete user message, and it increases request count without improving the endpoint decision.

**Add a second LLM request to judge question completeness.** Rejected because it adds latency and model-visible input that would need another logged request, while continuation phrases and explicit boundaries cover the current split failure without another model call.

**Run speaker embedding matching as a persistent identity database.** Rejected because the meeting assistant has no consented enrollment or identity source; recording-local diarization solves speaker separation without turning voice recordings into cross-meeting biometric profiles.

**Use one multimodal or end-to-end ASR model for speaker labels.** Rejected because it would replace the existing Qwen ASR path, require a different local serving contract, and make the optional feature unavailable to deployments that already have the current ASR stack.

## Verification

The live-assist question accumulator and session integration tests cover continuation joins, multiple-question splits, completeness cues, and the absence of triage before a fragment is complete. Meeting-minutes tests cover speaker interval validation, persistent worker reuse, diarized FFmpeg splitting, speaker-labelled transcript rendering, and resume layout handling. The focused meeting test set passes 89 tests across seven files.

## Consequences

- Interview answers wait for the accumulated text to become stable, so a connective-ended VAD fragment no longer triggers its own answer; unusual phrasing can still require a later fragment or remain heuristic.
- Diarization adds one local Python model, one full-recording inference pass, temporary interval WAV files, and one ASR request per detected speech interval. It is disabled by default and can use CUDA, MPS, or CPU through the configured device.
- A transcript carries optional `speaker` and `endSeconds` fields, and rendered artifacts show `[说话人 N]` only when a speaker label exists.
- Existing deployments that leave `speakerMode` unset keep their fixed-chunk behavior and do not need the optional `pyannote.audio` dependency.
