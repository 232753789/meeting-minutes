# Agent Note: Ship the GPL FFmpeg binary as a reviewed distribution decision

Status: implemented

English | [中文](2026-08-20-ffmpeg-static-gpl-distribution.zh.md)

## Problem

`@deepseek-ai/dsh-meeting-minutes` declares `ffmpeg-static` as a runtime dependency: the package installs a prebuilt FFmpeg executable that normalizes uploads to MP4/AAC and cuts the WAV chunks ASR consumes. That package declares `GPL-3.0-or-later`, because the binaries it installs are GPL builds of FFmpeg.

[`gen-third-party-notices`](../../../../scripts/gen-third-party-notices.ts) refuses to render notices for any non-permissive runtime dependency, and the pre-commit hook runs it, so the plugin could not be committed at all. The refusal is deliberate: a copyleft license reaching a shipped surface is a distribution decision, and the generator will not absorb one silently. Before this note the only authorized identity was the official Claude Agent SDK, which is an owner authorization rather than a reviewable rule others can follow.

## Decision

The project owner reviewed the terms and accepts shipping the GPL FFmpeg executable. `ffmpeg-static` is recorded in `AUTHORIZED_COPYLEFT_RUNTIME`, a name-keyed map in the generator whose value states the obligation the entry carries. The map is the record of the decision; it does not reclassify the license, and `THIRD_PARTY_NOTICES.md` discloses each entry with its obligation next to the dependency tables.

The facts the decision rests on:

- **Separate process, not linking.** The plugin runs FFmpeg through `ctx.subprocess.spawn` as an executable and links none of its code, so the MIT sources of this repository remain MIT.
- **The obligation travels with the binary.** Any artifact that ships the executable carries the GPL obligations for it, including making the corresponding source available; the source is [FFmpeg](https://github.com/FFmpeg/FFmpeg), and the builds are the third-party static builds `ffmpeg-static` documents.
- **An escape hatch already exists.** `ffmpegExecutable` points the plugin at a separately installed FFmpeg, so a deployment that does not want the bundled binary configures its own.

A future non-permissive runtime dependency is a new decision by the owner, not a precedent this entry sets: each addition to the map states its own obligation.

## Alternatives considered

- **Drop `ffmpeg-static` and require a configured FFmpeg.** Rejected for now: it removes the GPL binary from the distribution, but every user of the plugin then installs FFmpeg themselves before the first recording works, which trades a recorded license obligation for a setup failure on every fresh install.
- **Relax the generator to allow any copyleft runtime dependency.** Rejected: the gate exists to force exactly this review. A blanket allowance would let the next copyleft dependency arrive with no record of who accepted what.
- **Bypass the hook for the commit.** Rejected: the notices file is asserted in the test lane, so a bypass produces a stale artifact and leaves no record of the decision.

## Consequences

- `THIRD_PARTY_NOTICES.md` gains a disclosure paragraph listing every reviewed copyleft runtime package with its obligation.
- Anyone redistributing a build that carries the bundled FFmpeg executable is responsible for the GPL obligations named there.
- `isOwnerAuthorizedRuntime` now answers for two sources — the Claude Agent SDK identity and this map — and the generator still fails loud for any other non-permissive runtime dependency.
