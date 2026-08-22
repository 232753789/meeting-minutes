/**
 * One lazily started child process that speaks newline-delimited JSON over stdio.
 *
 * Both meeting packages drive a Python process this way: start it on first use, read one JSON
 * object per stdout line, write one per stdin line, keep it resident so an expensive model load
 * is paid once, and release it after an idle period so accelerator memory is not held forever.
 * This package owns that lifecycle; the protocol on top of it belongs to each caller.
 * @module @deepseek-ai/dsh-ndjson-worker
 */

import { createInterface } from 'node:readline'
import type { Interface as ReadlineInterface } from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-subprocess'

/** How the process is launched and how long it may sit idle. */
export interface NdjsonWorkerSpec {
  /** Command to resolve through `ctx.subprocess.resolveExecutable`. */
  readonly executable: string
  /** Arguments following the resolved executable. */
  readonly args: readonly string[]
  /** Working directory for the child. */
  readonly cwd: string
  /** Diagnostic prefix for every error this worker raises, e.g. `live-assist: recognizer`. */
  readonly label: string
  /** Idle time after which a live process with no outstanding work is stopped. */
  readonly idleShutdownMs: number
  /** Grace period between terminate and kill. */
  readonly graceMs: number
  /** Retained stderr used to explain an unexpected exit. */
  readonly diagnosticBytes: number
}

/** What the owner must supply for the worker to route output and report failure. */
export interface NdjsonWorkerHooks {
  /**
   * Handle one complete stdout line.
   * @param line - the line, without its terminator.
   */
  onLine(line: string): void
  /**
   * Report a failure that ends every outstanding request: the process died, or stdin broke.
   * @param error - what went wrong, already carrying the spec's label.
   */
  onFailure(error: Error): void
  /**
   * Whether no work is outstanding, so the idle countdown may run.
   * @returns true when the process may be stopped once the countdown elapses.
   */
  isIdle(): boolean
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/** Owns one child process, its line reader, and its idle countdown. */
export class NdjsonWorker {
  private handle: SubprocessHandle | undefined
  private lines: ReadlineInterface | undefined
  private starting: Promise<SubprocessHandle> | undefined
  private stopping: Promise<void> | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private closed = false

  /**
   * @param ctx - plugin context owning the subprocess.
   * @param spec - launch and idle settings, frozen for this worker's lifetime.
   * @param hooks - output routing, failure reporting, and the idle predicate.
   */
  constructor(
    private readonly ctx: Context,
    private readonly spec: NdjsonWorkerSpec,
    private readonly hooks: NdjsonWorkerHooks,
  ) {}

  /** Whether a process is currently live. */
  get running(): boolean {
    return this.handle !== undefined
  }

  /** Cancel any pending idle shutdown. */
  clearIdleShutdown(): void {
    if (this.idleTimer === undefined) return
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  /**
   * Start the idle countdown when the owner reports no outstanding work.
   *
   * The timer is unref'd, so a resident worker never holds the event loop open.
   */
  armIdleShutdown(): void {
    this.clearIdleShutdown()
    if (this.closed || this.handle === undefined || !this.hooks.isIdle()) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      void this.stop()
    }, this.spec.idleShutdownMs)
    this.idleTimer.unref()
  }

  /** Drop the current process and its reader; callers own the already-replaced check. */
  private release(): void {
    this.clearIdleShutdown()
    this.lines?.close()
    this.lines = undefined
    this.handle = undefined
  }

  /**
   * Ensure a process is live, starting one if needed.
   *
   * Concurrent callers share one start; a start that fails is not cached.
   * @returns settlement once the process is live and its reader is attached.
   */
  async ensureStarted(): Promise<void> {
    if (this.closed) throw new Error(`${this.spec.label} is closed`)
    if (this.stopping !== undefined) await this.stopping
    if (this.handle !== undefined) return
    this.starting ??= this.launch()
    try {
      await this.starting
    } finally {
      this.starting = undefined
    }
  }

  private async launch(): Promise<SubprocessHandle> {
    const executable = await this.ctx.subprocess.resolveExecutable(this.spec.executable)
    const handle = this.ctx.subprocess.spawn({
      argv: [executable, ...this.spec.args],
      cwd: this.spec.cwd,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: this.spec.diagnosticBytes },
      },
      graceMs: this.spec.graceMs,
    })
    if (handle.stdin === undefined || handle.stdout === undefined) {
      handle.terminate()
      await handle.waitForExit()
      throw new Error(`${this.spec.label} did not expose piped stdio`)
    }
    const lines = createInterface({ input: handle.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => { this.hooks.onLine(line) })
    this.lines = lines
    this.handle = handle
    void handle.done.then((outcome) => {
      if (this.handle !== handle) return
      this.release()
      const stderr = handle.collected.stderr?.readFrom(0).text.trim()
      this.hooks.onFailure(new Error(
        `${this.spec.label} exited with ${String(outcome.exitCode)}`
        + (stderr === undefined || stderr === '' ? '' : `: ${stderr}`),
      ))
    }, (error: unknown) => {
      if (this.handle !== handle) return
      this.release()
      this.hooks.onFailure(asError(error))
    })
    return handle
  }

  /**
   * Write one JSON value as a line to the child's stdin.
   *
   * A write that fails reports through `onFailure` and stops the process: a worker whose input
   * is broken cannot answer anything already outstanding.
   * @param payload - the value to serialize.
   */
  write(payload: unknown): void {
    this.handle?.stdin?.write(`${JSON.stringify(payload)}\n`, (error) => {
      if (error === null || error === undefined) return
      this.hooks.onFailure(new Error(`${this.spec.label} input failed: ${asError(error).message}`))
      void this.stop()
    })
  }

  /**
   * Stop the live process and await its exit; concurrent callers share one stop.
   * @returns settlement once the process tree is quiescent.
   */
  stop(): Promise<void> {
    this.clearIdleShutdown()
    if (this.stopping !== undefined) return this.stopping
    const handle = this.handle
    if (handle === undefined) return Promise.resolve()
    this.handle = undefined
    this.lines?.close()
    this.lines = undefined
    this.stopping = (async () => {
      handle.terminate()
      await handle.waitForExit()
    })().finally(() => { this.stopping = undefined })
    return this.stopping
  }

  /** Refuse further starts and release the current process. */
  async dispose(): Promise<void> {
    this.closed = true
    this.clearIdleShutdown()
    try {
      await this.starting
    } catch {
      // A failed start owns no live process; the caller is already disposing.
    }
    await this.stop()
  }
}
