# @deepseek-ai/dsh-ndjson-worker

English | [中文](README.zh.md)

One resident child process that speaks newline-delimited JSON over stdio. `NdjsonWorker` owns the lifecycle a plugin would otherwise hand-roll: start the process on first use and share one start between concurrent callers, read one line at a time from stdout, write one JSON value per line to stdin, stop the process once the owner reports no outstanding work for `idleShutdownMs`, and release it on disposal. Every error it raises carries the caller's `label`, so a diagnostic names the plugin's own vocabulary rather than this package's.

The protocol on top of the lines belongs to the caller. `NdjsonWorkerHooks` is the whole seam: `onLine` receives each stdout line, `onFailure` reports a process that died or a broken stdin — the caller decides what that means for its outstanding requests — and `isIdle` answers whether the idle countdown may run.

`dsh-meeting-minutes` drives a request/response protocol over it, correlating replies by id; `dsh-live-assist` drives an event stream, routing lines to per-session listeners. Both keep an expensive model resident between calls, which is what the idle countdown exists to bound.

## Known Limitations and Deferred Work

- Lines only. A worker that needs to exchange binary payloads must encode them (both current callers base64 audio into the JSON), and a very large payload pays that encoding on every message.
- One process per worker instance. There is no pool: a caller that needs concurrency either serializes onto one process, as both current callers do, or constructs several workers.
- `onFailure` reports; it does not recover. Restarting after a crash is the caller's decision, made by calling `ensureStarted` again.
