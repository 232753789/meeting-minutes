#!/usr/bin/env python3
"""Persistent NDJSON worker: silero-vad utterance segmentation plus Qwen3-ASR transcription.

Audio never reaches the filesystem. PCM arrives base64-encoded on stdin, is segmented in
memory, and each completed utterance is handed to Qwen3-ASR as an `(ndarray, sample_rate)`
pair. A reader thread owns segmentation so a long inference never stalls intake; a single
inference thread owns the model, keeping requests serial as the batch-size-1 model requires.
"""

from __future__ import annotations

import argparse
import base64
import gc
import json
import queue
import sys
import threading
from dataclasses import dataclass
from typing import Any

SAMPLE_RATE = 16000
# silero-vad's 16 kHz model is specified for exactly 512-sample windows.
VAD_WINDOW = 512


@dataclass(frozen=True)
class RuntimeChoice:
    device: str
    dtype: Any


@dataclass
class Utterance:
    session: str
    index: int
    samples: Any
    seconds: float


def runtime_choices(torch: Any, configured: str) -> list[RuntimeChoice]:
    """Return the configured runtime or the ordered automatic fallback list."""
    if configured == "cuda":
        return [RuntimeChoice("cuda:0", torch.bfloat16)]
    if configured == "mps":
        return [RuntimeChoice("mps", torch.float16)]
    if configured == "cpu":
        return [RuntimeChoice("cpu", torch.float32)]
    choices: list[RuntimeChoice] = []
    if torch.cuda.is_available():
        choices.append(RuntimeChoice("cuda:0", torch.bfloat16))
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        choices.append(RuntimeChoice("mps", torch.float16))
    choices.append(RuntimeChoice("cpu", torch.float32))
    return choices


def load_asr_model(model_path: str, configured_device: str, max_new_tokens: int) -> Any:
    """Load once; auto mode may fall back from an unsupported accelerator to CPU."""
    try:
        import torch
        from qwen_asr import Qwen3ASRModel
    except Exception as error:
        raise RuntimeError(
            'qwen-asr is unavailable; install it in this Python environment with "pip install -U qwen-asr"'
        ) from error

    failures: list[str] = []
    for choice in runtime_choices(torch, configured_device):
        try:
            model = Qwen3ASRModel.from_pretrained(
                model_path,
                dtype=choice.dtype,
                device_map=choice.device,
                max_inference_batch_size=1,
                max_new_tokens=max_new_tokens,
            )
            print(f"live-assist ASR loaded {model_path} on {choice.device}", file=sys.stderr, flush=True)
            return model
        except Exception as error:
            failures.append(f"{choice.device}: {error}")
            if configured_device != "auto":
                break
            gc.collect()
            if choice.device.startswith("cuda") and torch.cuda.is_available():
                torch.cuda.empty_cache()
            if choice.device == "mps" and hasattr(torch, "mps"):
                torch.mps.empty_cache()
    raise RuntimeError("unable to load Qwen3-ASR; " + " | ".join(failures))


def load_vad() -> tuple[Any, Any]:
    """Load the silero-vad model and return it with the VADIterator class."""
    try:
        from silero_vad import load_silero_vad, VADIterator
    except Exception as error:
        raise RuntimeError(
            'silero-vad is unavailable; install it in this Python environment with "pip install -U silero-vad"'
        ) from error
    return load_silero_vad(), VADIterator


class Emitter:
    """Serializes stdout writes across the reader and inference threads."""

    def __init__(self) -> None:
        self._lock = threading.Lock()

    def send(self, payload: dict[str, Any]) -> None:
        line = json.dumps(payload, ensure_ascii=False)
        with self._lock:
            print(line, flush=True)


class SessionSegmenter:
    """Per-session VAD state plus the rolling buffer that backs one utterance."""

    def __init__(self, options: argparse.Namespace, vad_model: Any, vad_iterator_class: Any, numpy: Any) -> None:
        self._np = numpy
        self._options = options
        self._iterator = vad_iterator_class(
            vad_model,
            threshold=options.vad_threshold,
            sampling_rate=SAMPLE_RATE,
            min_silence_duration_ms=options.min_silence_ms,
            speech_pad_ms=options.speech_pad_ms,
        )
        self._pad = int(SAMPLE_RATE * options.speech_pad_ms / 1000)
        self._min_samples = int(SAMPLE_RATE * options.min_utterance_ms / 1000)
        self._max_samples = int(SAMPLE_RATE * options.max_utterance_ms / 1000)
        # Absolute sample position of buffer[0], so VADIterator's absolute indices stay resolvable
        # after the retained prefix is trimmed.
        self._buffer_origin = 0
        self._buffer = self._np.zeros(0, dtype=self._np.float32)
        self._pending = self._np.zeros(0, dtype=self._np.float32)
        self._consumed = 0
        self._speech_start: int | None = None
        self._index = 0

    @property
    def speaking(self) -> bool:
        return self._speech_start is not None

    def reset(self) -> None:
        self._iterator.reset_states()
        self._speech_start = None

    def _cut(self, start: int, end: int) -> Utterance | None:
        """Slice absolute sample positions out of the buffer, then drop what precedes the next one.

        VADIterator already applies `speech_pad_ms` to both coordinates it reports, so these
        positions are used verbatim; padding them again would splice in neighbouring speech.
        """
        begin = max(start, self._buffer_origin)
        finish = min(end, self._buffer_origin + len(self._buffer))
        samples = self._buffer[begin - self._buffer_origin:finish - self._buffer_origin]
        keep_from = max(finish - self._pad, self._buffer_origin)
        self._buffer = self._buffer[keep_from - self._buffer_origin:]
        self._buffer_origin = keep_from
        # Both coordinates already carry `speech_pad_ms`, so the minimum-length test has to
        # discount it: otherwise a 150 ms cough padded to 550 ms outlives a 400 ms floor.
        if len(samples) - 2 * self._pad < self._min_samples:
            return None
        self._index += 1
        return Utterance("", self._index, samples.copy(), len(samples) / SAMPLE_RATE)

    def push(self, chunk: Any) -> tuple[list[Utterance], list[bool]]:
        """Feed one PCM chunk; return completed utterances and speech-state transitions."""
        self._buffer = self._np.concatenate((self._buffer, chunk))
        self._pending = self._np.concatenate((self._pending, chunk))
        utterances: list[Utterance] = []
        transitions: list[bool] = []
        while len(self._pending) >= VAD_WINDOW:
            window = self._pending[:VAD_WINDOW]
            self._pending = self._pending[VAD_WINDOW:]
            self._consumed += VAD_WINDOW
            event = self._iterator(window)
            if event is not None and "start" in event:
                self._speech_start = int(event["start"])
                transitions.append(True)
            elif event is not None and "end" in event and self._speech_start is not None:
                start = self._speech_start
                self._speech_start = None
                transitions.append(False)
                cut = self._cut(start, int(event["end"]))
                if cut is not None:
                    utterances.append(cut)
            elif self._speech_start is not None and self._consumed - self._speech_start >= self._max_samples:
                # A counterpart who never pauses would otherwise hold the answer back indefinitely.
                start = self._speech_start
                self._speech_start = self._consumed
                cut = self._cut(start, self._consumed)
                if cut is not None:
                    utterances.append(cut)
        if self._speech_start is None and len(self._buffer) > self._pad:
            # Silence needs no history beyond the lead-in padding of the next utterance.
            drop = len(self._buffer) - self._pad
            self._buffer = self._buffer[drop:]
            self._buffer_origin += drop
        return utterances, transitions


def inference_loop(
    work: "queue.Queue[Utterance | None]",
    emitter: Emitter,
    options: argparse.Namespace,
) -> None:
    """Own the ASR model and answer queued utterances one at a time."""
    model: Any | None = None
    while True:
        item = work.get()
        if item is None:
            return
        try:
            if model is None:
                model = load_asr_model(options.model, options.device, options.max_new_tokens)
                emitter.send({"type": "model-ready"})
            language = None if options.language.lower() == "auto" else options.language
            results = model.transcribe(audio=(item.samples, SAMPLE_RATE), language=language)
            if not isinstance(results, list) or not results:
                raise RuntimeError("qwen-asr returned no result")
            text = getattr(results[0], "text", None)
            if not isinstance(text, str):
                raise RuntimeError("qwen-asr returned no transcript text")
            emitter.send({
                "type": "utterance",
                "session": item.session,
                "index": item.index,
                "text": text.strip(),
                "seconds": round(item.seconds, 3),
            })
        except Exception as error:
            emitter.send({"type": "error", "session": item.session, "message": str(error)})


def request_object(line: str) -> dict[str, Any]:
    """Decode one request and reject malformed fields before it reaches session state."""
    value = json.loads(line)
    if not isinstance(value, dict):
        raise ValueError("request must be an object")
    if not isinstance(value.get("type"), str):
        raise ValueError("request type must be a string")
    if not isinstance(value.get("session"), str) or not value["session"]:
        raise ValueError("session must be a non-empty string")
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--device", choices=("auto", "cuda", "mps", "cpu"), default="auto")
    parser.add_argument("--language", default="Chinese")
    parser.add_argument("--max-new-tokens", type=int, default=256)
    parser.add_argument("--vad-threshold", type=float, default=0.5)
    parser.add_argument("--min-silence-ms", type=int, default=700)
    parser.add_argument("--speech-pad-ms", type=int, default=200)
    parser.add_argument("--min-utterance-ms", type=int, default=400)
    parser.add_argument("--max-utterance-ms", type=int, default=20000)
    options = parser.parse_args()

    emitter = Emitter()
    try:
        import numpy
        vad_model, vad_iterator_class = load_vad()
    except Exception as error:
        emitter.send({"type": "error", "session": None, "message": str(error)})
        return 1

    work: "queue.Queue[Utterance | None]" = queue.Queue()
    worker = threading.Thread(target=inference_loop, args=(work, emitter, options), daemon=True)
    worker.start()
    emitter.send({"type": "ready"})

    sessions: dict[str, SessionSegmenter] = {}
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            request = request_object(line)
            session = request["session"]
            kind = request["type"]
            if kind == "start":
                sessions[session] = SessionSegmenter(options, vad_model, vad_iterator_class, numpy)
            elif kind == "stop":
                sessions.pop(session, None)
            elif kind == "audio":
                segmenter = sessions.get(session)
                if segmenter is None:
                    continue
                pcm = base64.b64decode(request["pcm"], validate=True)
                chunk = numpy.frombuffer(pcm, dtype="<i2").astype(numpy.float32) / 32768.0
                utterances, transitions = segmenter.push(chunk)
                for speaking in transitions:
                    emitter.send({"type": "speech", "session": session, "speaking": speaking})
                for utterance in utterances:
                    utterance.session = session
                    work.put(utterance)
            else:
                raise ValueError(f"unsupported request type {kind}")
        except Exception as error:
            emitter.send({"type": "error", "session": None, "message": str(error)})
    work.put(None)
    worker.join(timeout=10)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
