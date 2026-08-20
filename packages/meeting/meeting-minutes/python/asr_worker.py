#!/usr/bin/env python3
"""Persistent NDJSON worker for local Qwen3-ASR inference."""

from __future__ import annotations

import argparse
import gc
import json
import sys
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class RuntimeChoice:
    device: str
    dtype: Any


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


def load_model(model_path: str, configured_device: str, max_new_tokens: int) -> Any:
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
            print(
                f"meeting-minutes ASR loaded {model_path} on {choice.device}",
                file=sys.stderr,
                flush=True,
            )
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


def request_object(line: str) -> dict[str, Any]:
    """Decode one request and reject malformed fields before model invocation."""
    value = json.loads(line)
    if not isinstance(value, dict):
        raise ValueError("request must be an object")
    if not isinstance(value.get("id"), int):
        raise ValueError("request id must be an integer")
    if not isinstance(value.get("audio"), str) or not value["audio"]:
        raise ValueError("audio must be a non-empty path")
    if not isinstance(value.get("language"), str) or not value["language"]:
        raise ValueError("language must be a non-empty string")
    return value


def transcript_text(result: Any) -> str:
    """Extract text from the qwen-asr result list without retaining model objects."""
    if not isinstance(result, list) or not result:
        raise RuntimeError("qwen-asr returned no result")
    text = getattr(result[0], "text", None)
    if not isinstance(text, str) or not text.strip():
        raise RuntimeError("qwen-asr returned no transcript text")
    return text.strip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--device", choices=("auto", "cuda", "mps", "cpu"), default="auto")
    parser.add_argument("--max-new-tokens", type=int, default=2048)
    args = parser.parse_args()
    model: Any | None = None

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        request_id: int | None = None
        try:
            request = request_object(line)
            request_id = request["id"]
            if model is None:
                model = load_model(args.model, args.device, args.max_new_tokens)
            language = None if request["language"].lower() == "auto" else request["language"]
            results = model.transcribe(audio=request["audio"], language=language)
            response = {"id": request_id, "ok": True, "text": transcript_text(results)}
        except Exception as error:
            response = {"id": request_id, "ok": False, "error": str(error)}
        print(json.dumps(response, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
