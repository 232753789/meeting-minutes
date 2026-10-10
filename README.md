# meeting-minutes/ — browser-recorded meeting minutes

English | [中文](README.zh.md)

A self-contained optional plugin project for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): one installable Web profile bundle that records a meeting in the browser (microphone, optionally mixed with the computer's own audio output) or takes an uploaded MP4, transcribes it with local or remote Qwen3-ASR-1.7B — optionally attributing speakers with a local pyannote pipeline — and summarizes the transcript into downloadable Markdown minutes through the Harness LLM route. It depends on no other plugin.

| Package | Role | ctx key |
|---|---|---|
| [`meeting-minutes/`](meeting-minutes/README.md) | Browser recorder and history, private recording storage, FFmpeg normalization, Qwen ASR, speaker diarization, and Markdown minutes | registers Web routes, a `conversation.input.tool` entry, a `settings.plugin.item` card, and the `meeting-minutes` settings namespace |

## Build

```bash
cd meeting-minutes
pnpm install
pnpm run build
```

## Register into DeepSeek Harness

From the root of a DeepSeek Harness checkout:

```bash
git clone https://github.com/232753789/meeting-minutes packages/meeting-minutes
(cd packages/meeting-minutes/meeting-minutes && pnpm install && pnpm run build)
pnpm dsh plugin --profile web add ./packages/meeting-minutes/meeting-minutes
pnpm dsh web
```

With an installed `dsh`, pass the built package directory by path instead:

```bash
dsh plugin --profile web add /path/to/meeting-minutes/meeting-minutes
dsh web
```

Remove it with `pnpm dsh plugin --profile web remove @deepseek-ai/dsh-meeting-minutes`. Model setup, configuration, and the HTTP surface are described in [the package README](meeting-minutes/README.md).
