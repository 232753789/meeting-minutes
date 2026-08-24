#!/usr/bin/env python3
"""Persistent local pyannote speaker-diarization worker."""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any


def load_pipeline(model_path: str, device: str) -> Any:
    """Load a local pyannote pipeline and place it on the selected device."""
    try:
        import torch
        from pyannote.audio import Pipeline
    except Exception as error:
        raise RuntimeError(
            'pyannote.audio is unavailable; install it with "pip install -U pyannote.audio"'
        ) from error
    pipeline = Pipeline.from_pretrained(model_path)
    if pipeline is None:
        raise RuntimeError(f'pyannote did not load a pipeline from {model_path}')
    if device == "auto":
        if torch.cuda.is_available():
            device = "cuda"
        elif getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
            device = "mps"
        else:
            device = "cpu"
    pipeline.to(torch.device(device))
    print(f"meeting-minutes diarization loaded {model_path} on {device}", file=sys.stderr, flush=True)
    return pipeline


def request_object(line: str) -> dict[str, Any]:
    """Decode and validate one diarization request."""
    value = json.loads(line)
    if not isinstance(value, dict):
        raise ValueError("request must be an object")
    if not isinstance(value.get("id"), int):
        raise ValueError("request id must be an integer")
    if not isinstance(value.get("audio"), str) or not value["audio"]:
        raise ValueError("audio must be a non-empty path")
    return value


def intervals(result: Any) -> list[dict[str, Any]]:
    """Convert pyannote tracks to stable first-seen speaker ids."""
    labels: dict[str, str] = {}
    output: list[dict[str, Any]] = []
    for turn, _unused, label in result.itertracks(yield_label=True):
        if label not in labels:
            labels[label] = f"speaker-{len(labels) + 1}"
        output.append({
            "startSeconds": round(float(turn.start), 3),
            "endSeconds": round(float(turn.end), 3),
            "speaker": labels[label],
        })
    return output


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--device", choices=("auto", "cuda", "mps", "cpu"), default="auto")
    args = parser.parse_args()
    pipeline: Any | None = None
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        request_id: int | None = None
        try:
            request = request_object(line)
            request_id = request["id"]
            if pipeline is None:
                pipeline = load_pipeline(args.model, args.device)
            result = pipeline(request["audio"])
            response = {"id": request_id, "ok": True, "intervals": intervals(result)}
        except Exception as error:
            response = {"id": request_id, "ok": False, "error": str(error)}
        print(json.dumps(response, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
