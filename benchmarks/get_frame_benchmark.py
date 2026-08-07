#!/usr/bin/env python3
"""Measure direct VapourSynth get_frame calls for fast iteration benchmarks."""

from __future__ import annotations

import argparse
import gc
import json
import runpy
import statistics
import sys
import time
from pathlib import Path
from types import ModuleType

import vapoursynth as vs


def ensure_preview_fallback() -> None:
    try:
        import vspreview.api  # noqa: F401
    except ModuleNotFoundError:
        package = ModuleType("vspreview")
        api = ModuleType("vspreview.api")
        api.is_preview = lambda: False
        package.api = api
        sys.modules["vspreview"] = package
        sys.modules["vspreview.api"] = api


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--script", required=True, help="VapourSynth fixture to execute")
    parser.add_argument("--frame", type=int, default=0, help="Frame number to request")
    parser.add_argument(
        "--node",
        default="zsmooth",
        help="Fixture namespace variable to time (default: zsmooth)",
    )
    parser.add_argument("--iterations", type=int, required=True)
    parser.add_argument("--warmup", type=int, default=0)
    parser.add_argument(
        "--arg",
        action="append",
        default=[],
        metavar="KEY=VALUE",
        help="Fixture global; may be repeated",
    )
    return parser.parse_args()


def fixture_globals(arguments: list[str]) -> dict[str, str]:
    values = {"output": "zsmooth"}
    for argument in arguments:
        key, separator, value = argument.partition("=")
        if not separator or not key:
            raise ValueError(f"--arg must be KEY=VALUE, got {argument!r}")
        values[key] = value
    return values


def request_frame(
    script: Path, values: dict[str, str], frame: int, node_name: str
) -> float:
    # Clearing outside the timed region prevents an earlier iteration from
    # turning the next request into a cache lookup.
    vs.core.clear_cache()
    namespace = runpy.run_path(str(script), init_globals=values.copy())
    node = namespace.get(node_name)
    if node is None:
        raise RuntimeError(f"{script} did not define the {node_name} output node")
    start = time.perf_counter_ns()
    returned_frame = node.get_frame(frame)
    elapsed_ms = (time.perf_counter_ns() - start) / 1_000_000
    if returned_frame is None:
        raise RuntimeError(f"get_frame({frame}) returned no frame")

    # Release the graph and its frame before the next iteration. This is also
    # outside the timed region and keeps each sample independent.
    del returned_frame, node, namespace
    gc.collect()
    vs.core.clear_cache()
    return elapsed_ms


def main() -> None:
    arguments = parse_args()
    if arguments.iterations < 1:
        raise ValueError("--iterations must be positive")
    if arguments.warmup < 0:
        raise ValueError("--warmup must be non-negative")
    if arguments.frame < 0:
        raise ValueError("--frame must be non-negative")

    ensure_preview_fallback()
    script = Path(arguments.script).resolve()
    values = fixture_globals(arguments.arg)

    for _ in range(arguments.warmup):
        request_frame(script, values, arguments.frame, arguments.node)

    samples_ms = [
        request_frame(script, values, arguments.frame, arguments.node)
        for _ in range(arguments.iterations)
    ]
    fps_values = [1000 / sample for sample in samples_ms]

    print(
        json.dumps(
            {
                "frame": arguments.frame,
                "iterations": arguments.iterations,
                "warmup": arguments.warmup,
                "samples_ms": samples_ms,
                "fps_values": fps_values,
                "average_ms": statistics.mean(samples_ms),
                "median_ms": statistics.median(samples_ms),
                "min_ms": min(samples_ms),
                "max_ms": max(samples_ms),
                "median_fps": statistics.median(fps_values),
            }
        )
    )


if __name__ == "__main__":
    main()
