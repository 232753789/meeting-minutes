"""Utterance-segmentation tests for the recognizer worker.

These exercise `SessionSegmenter` against a scripted stand-in for silero-vad's `VADIterator`,
so they need neither the VAD model nor Qwen weights — only numpy. They are not part of the
repository's `pnpm run test` lane; run them directly:

    python3 -m pytest packages/meeting/live-assist/python
"""

from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path

import numpy as np
import pytest

_SPEC = importlib.util.spec_from_file_location(
    "live_asr_worker", Path(__file__).with_name("live_asr_worker.py")
)
assert _SPEC is not None and _SPEC.loader is not None
worker = importlib.util.module_from_spec(_SPEC)
sys.modules["live_asr_worker"] = worker
_SPEC.loader.exec_module(worker)

SR = worker.SAMPLE_RATE
WINDOW = worker.VAD_WINDOW


class ScriptedVAD:
    """Reports speech over fixed sample ranges, applying speech_pad exactly as VADIterator does."""

    def __init__(self, model, threshold, sampling_rate, min_silence_duration_ms, speech_pad_ms):
        self.pad = sampling_rate * speech_pad_ms / 1000
        self.min_silence = sampling_rate * min_silence_duration_ms / 1000
        self.speech = model
        self.reset_states()

    def reset_states(self):
        self.cur = 0
        self.triggered = False
        self.temp_end = 0

    def __call__(self, x):
        self.cur += len(x)
        loud = any(start <= self.cur - WINDOW < end for start, end in self.speech)
        if loud and self.temp_end:
            self.temp_end = 0
        if loud and not self.triggered:
            self.triggered = True
            return {"start": int(max(0, self.cur - self.pad - WINDOW))}
        if not loud and self.triggered:
            if not self.temp_end:
                self.temp_end = self.cur
            if self.cur - self.temp_end < self.min_silence:
                return None
            end = int(self.temp_end + self.pad - WINDOW)
            self.temp_end = 0
            self.triggered = False
            return {"end": end}
        return None


def options(**overrides):
    values = dict(
        vad_threshold=0.5,
        min_silence_ms=700,
        speech_pad_ms=200,
        min_utterance_ms=400,
        max_utterance_ms=20000,
    )
    values.update(overrides)
    return argparse.Namespace(**values)


def run(speech, total_seconds, opts, chunk_ms=100):
    """Feed `total_seconds` of audio whose samples encode their own absolute index."""
    segmenter = worker.SessionSegmenter(opts, speech, ScriptedVAD, np)
    utterances, transitions = [], []
    step = int(SR * chunk_ms / 1000)
    for offset in range(0, int(SR * total_seconds), step):
        produced, changed = segmenter.push(np.arange(offset, offset + step, dtype=np.float32))
        utterances += produced
        transitions += changed
    return segmenter, utterances, transitions


def test_separate_utterances_are_cut_apart():
    speech = [(int(1.0 * SR), int(3.0 * SR)), (int(5.0 * SR), int(7.5 * SR))]
    _, utterances, transitions = run(speech, 10, options())
    assert [u.index for u in utterances] == [1, 2]
    # 2.0 s and 2.5 s of speech, each padded by 200 ms on both sides.
    assert utterances[0].seconds == pytest.approx(2.4, abs=0.05)
    assert utterances[1].seconds == pytest.approx(2.9, abs=0.05)
    assert transitions == [True, False, True, False]


def test_padding_does_not_rescue_a_too_short_noise():
    """A 150 ms cough padded to 550 ms must still fail a 400 ms floor."""
    _, utterances, _ = run([(int(1.0 * SR), int(1.15 * SR))], 4, options())
    assert utterances == []


def test_uninterrupted_speech_is_cut_at_the_ceiling():
    _, utterances, _ = run([(int(0.5 * SR), int(14.0 * SR))], 16, options(max_utterance_ms=5000))
    assert len(utterances) >= 2
    assert all(u.seconds <= 5.5 for u in utterances)


def test_silence_does_not_grow_the_buffer():
    segmenter = worker.SessionSegmenter(options(), [], ScriptedVAD, np)
    for _ in range(0, SR * 120, 1600):
        segmenter.push(np.zeros(1600, dtype=np.float32))
    assert len(segmenter._buffer) <= segmenter._pad + 1600


def test_cut_audio_is_contiguous_and_correctly_placed():
    _, utterances, _ = run([(int(2.0 * SR), int(4.0 * SR))], 6, options())
    samples = utterances[0].samples
    assert samples[0] / SR == pytest.approx(1.8, abs=0.05)
    assert samples[-1] / SR == pytest.approx(4.2, abs=0.05)
    assert np.all(np.diff(samples) == 1.0)


def test_reset_clears_speech_state():
    segmenter = worker.SessionSegmenter(options(), [(0, SR * 10)], ScriptedVAD, np)
    segmenter.push(np.zeros(1600, dtype=np.float32))
    assert segmenter.speaking
    segmenter.reset()
    assert not segmenter.speaking
