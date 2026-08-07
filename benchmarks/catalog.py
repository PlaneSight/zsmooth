"""Generated benchmark capabilities for the zsmooth VapourSynth plugin.

The catalog deliberately contains only JSON-shaped data. VapourSynth is loaded
by :mod:`benchmarks.harness` after its plugin search path has been set, so case
expansion and stable IDs also work without importing VapourSynth.
"""

from __future__ import annotations

import copy
import hashlib
import json
from collections.abc import Iterable, Mapping
from typing import Any

SCHEMA_VERSION = 1
CATALOG_VERSION = "1"
INPUT_VERSION = 1
DEFAULT_WIDTH = 64
DEFAULT_HEIGHT = 48
DEFAULT_LENGTH = 32
DEFAULT_FRAME_COUNT = 3
FORMAT_NAMES = ("u8", "u16", "f16", "f32")

# These are the names registered by src/zsmooth.zig. InterQuartileMean is
# commonly called IQM in benchmark reports, but the registered VapourSynth
# function name is retained as the canonical name.
CATALOG_ORDER = (
    "Clense", "ForwardClense", "BackwardClense", "FluxSmoothT",
    "FluxSmoothST", "Cnr4", "CCD", "DCTFilter", "DegrainMedian",
    "InterQuartileMean", "Median", "RemoveGrain", "Repair", "SmartMedian",
    "TemporalMedian", "TemporalRepair", "TemporalSoften", "TTempSmooth",
    "VerticalCleaner",
)
FUNCTION_ALIASES = {"IQM": "InterQuartileMean"}
_ALL = list(FORMAT_NAMES)
_INTEGER = ["u8", "u16"]
_NO_F16 = ["u8", "u16", "f32"]

# Each source/signature reference points at a registration declaration in
# src/*.zig. reference_args names additional vnode arguments that the harness
# creates as deterministic BlankClips.
CATALOG: dict[str, dict[str, Any]] = {
    "Clense": {
        "source": "src/clense.zig:452-455",
        "signature": "clip:vnode;previous:vnode:opt;next:vnode:opt;planes:int[]:opt",
        "formats": _ALL, "topology": "temporal_reference",
        "reference_args": ["previous", "next"], "cases": [{}],
    },
    "ForwardClense": {
        "source": "src/clense.zig:452-455",
        "signature": "clip:vnode;planes:int[]:opt",
        "formats": _ALL, "topology": "temporal", "reference_args": [],
        "cases": [{}],
    },
    "BackwardClense": {
        "source": "src/clense.zig:452-455",
        "signature": "clip:vnode;planes:int[]:opt",
        "formats": _ALL, "topology": "temporal", "reference_args": [],
        "cases": [{}],
    },
    "FluxSmoothT": {
        "source": "src/fluxsmooth.zig:816-818",
        "signature": "clip:vnode;temporal_threshold:float[]:opt;planes:int[]:opt;scalep:int:opt",
        "formats": _ALL, "topology": "temporal", "reference_args": [],
        "cases": [{"temporal_threshold": [20.0], "scalep": 1}],
    },
    "FluxSmoothST": {
        "source": "src/fluxsmooth.zig:816-818",
        "signature": "clip:vnode;temporal_threshold:float[]:opt;spatial_threshold:float[]:opt;planes:int[]:opt;scalep:int:opt",
        "formats": _ALL, "topology": "temporal", "reference_args": [],
        "cases": [{
            "temporal_threshold": [20.0], "spatial_threshold": [20.0], "scalep": 1,
        }],
    },
    "Cnr4": {
        "source": "src/cnr4.zig:1298-1308",
        "signature": "clip:vnode;mode:data:opt;radius:int:opt;sense:int[]:opt;str:int[]:opt;pow:float[]:opt;tmode:int:opt;wmode:int:opt;scenechange:int:opt;ref:vnode:opt",
        # Cnr4 explicitly rejects float and non-YUV input.
        "formats": _INTEGER, "topology": "temporal_reference",
        "reference_args": ["ref"], "cases": [
            {
                "mode": "oxx", "radius": 1, "sense": [35, -1, -1],
                "str": [192, -1, -1], "pow": [1.0, 1.0, 1.0],
                "tmode": 0, "wmode": 1, "scenechange": 0,
            },
            {
                "mode": "oxx", "radius": 2, "sense": [35, -1, -1],
                "str": [192, -1, -1], "pow": [1.0, 1.0, 1.0],
                "tmode": 0, "wmode": 1, "scenechange": 0,
            },
        ],
    },
    "CCD": {
        "source": "src/ccd.zig:1164-1170",
        "signature": "clip:vnode;threshold:float:opt;temporal_radius:int:opt;points:int[]:opt;scale:float:opt;ref:vnode:opt",
        "formats": _ALL, "topology": "temporal_reference",
        "reference_args": ["ref"], "cases": [
            {
                "threshold": 20.0, "temporal_radius": 0,
                "points": [True, True, False], "scale": 1.0,
            },
            {
                "threshold": 20.0, "temporal_radius": 3,
                "points": [True, True, False], "scale": 1.0,
            },
        ],
    },
    "DCTFilter": {
        "source": "src/dctfilter.zig:304-305",
        "signature": "clip:vnode;factors:float[];planes:int[]:opt",
        "formats": _ALL, "topology": "single", "reference_args": [],
        # The implementation indexes eight entries while constructing its 8x8 matrix.
        "cases": [{"factors": [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]}],
    },
    "DegrainMedian": {
        "source": "src/degrain_median.zig:835-836",
        "signature": "clip:vnode;limit:float[]:opt;mode:int[]:opt;interlaced:int:opt;norow:int:opt;scalep:int:opt",
        "formats": _ALL, "topology": "single", "reference_args": [],
        "cases": [
            {
                "limit": [4.0, 4.0, 4.0], "mode": [mode],
                "interlaced": 0, "norow": 0, "scalep": 1,
            }
            for mode in range(6)
        ],
    },
    "InterQuartileMean": {
        "source": "src/inter_quartile_mean.zig:498-499",
        "signature": "clip:vnode;radius:int[]:opt;planes:int[]:opt",
        "formats": _ALL, "topology": "single", "reference_args": [],
        "aliases": ["IQM"], "cases": [{"radius": [radius]} for radius in (1, 2, 3)],
    },
    "Median": {
        "source": "src/median.zig:327-328",
        "signature": "clip:vnode;radius:int[]:opt;planes:int[]:opt",
        "formats": _ALL, "topology": "single", "reference_args": [],
        "cases": [{"radius": [radius]} for radius in (1, 2, 3)],
    },
    "RemoveGrain": {
        "source": "src/remove_grain.zig:1488-1489",
        "signature": "clip:vnode;mode:int[]",
        "formats": _ALL, "topology": "single", "reference_args": [],
        "cases": [{"mode": [mode]} for mode in range(25)],
    },
    "Repair": {
        "source": "src/repair.zig:1588-1589",
        "signature": "clip:vnode;repairclip:vnode;mode:int[]",
        "formats": _ALL, "topology": "reference", "reference_args": ["repairclip"],
        "cases": [{"mode": [mode]} for mode in range(25)],
    },
    "SmartMedian": {
        "source": "src/smart_median.zig:447-448",
        "signature": "clip:vnode;radius:int[]:opt;threshold:float[]:opt;scalep:int:opt;planes:int[]:opt",
        "formats": _ALL, "topology": "single", "reference_args": [],
        "cases": [
            {"radius": [radius], "threshold": [50.0], "scalep": 1}
            for radius in (1, 2, 3)
        ],
    },
    "TemporalMedian": {
        "source": "src/temporal_median.zig:364-365",
        "signature": "clip:vnode;radius:int:opt;planes:int[]:opt;scenechange:int:opt",
        "formats": _ALL, "topology": "temporal", "reference_args": [],
        "cases": [{"radius": 1, "scenechange": 0}, {"radius": 10, "scenechange": 0}],
    },
    "TemporalRepair": {
        "source": "src/temporal_repair.zig:755-756",
        "signature": "clip:vnode;repairclip:vnode;mode:int[]:opt;planes:int[]:opt",
        "formats": _ALL, "topology": "temporal_reference",
        "reference_args": ["repairclip"], "cases": [{"mode": [mode]} for mode in range(5)],
    },
    "TemporalSoften": {
        "source": "src/temporal_soften.zig:492-498",
        "signature": "clip:vnode;radius:int:opt;threshold:float[]:opt;scenechange:int:opt;scalep:int:opt;planes:int[]:opt",
        "formats": _ALL, "topology": "temporal", "reference_args": [],
        "cases": [
            {
                "radius": radius, "threshold": [4.0, 8.0, 8.0],
                "scenechange": 0, "scalep": 1,
            }
            for radius in (1, 7)
        ],
    },
    "TTempSmooth": {
        "source": "src/ttempsmooth.zig:887-888",
        "signature": "clip:vnode;maxr:int:opt;thresh:int[]:opt;mdiff:int[]:opt;strength:int:opt;scthresh:float:opt;fp:int:opt;pfclip:vnode:opt;planes:int[]:opt",
        # Math.pow has no f16 implementation in the TTempSmooth path.
        "formats": _NO_F16, "topology": "temporal", "reference_args": [],
        "cases": [{
            "maxr": 1, "thresh": [4, 5, 5], "mdiff": [2, 3, 3],
            "strength": 2, "scthresh": 0.0, "fp": 1,
        }],
    },
    "VerticalCleaner": {
        "source": "src/vertical_cleaner.zig:400-401",
        "signature": "clip:vnode;mode:int[]",
        "formats": _ALL, "topology": "single", "reference_args": [],
        "cases": [{"mode": [mode]} for mode in range(3)],
    },
}


def canonical_json(value: Any) -> str:
    """Serialize JSON deterministically for files and SHA-256 identifiers."""

    return json.dumps(
        value, ensure_ascii=False, allow_nan=False, sort_keys=True,
        separators=(",", ":"),
    )


def _sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def case_id(case: Mapping[str, Any]) -> str:
    """Return the stable ID for a case, ignoring a previously stored id."""

    return _sha256({key: value for key, value in case.items() if key != "id"})


def plan_id(plan_or_cases: Mapping[str, Any] | Iterable[Mapping[str, Any]]) -> str:
    """Return the stable ID for a plan or an iterable of plan cases."""

    if isinstance(plan_or_cases, Mapping):
        material = {
            key: value for key, value in plan_or_cases.items() if key != "plan_id"
        }
    else:
        material = {
            "schema_version": SCHEMA_VERSION, "catalog_version": CATALOG_VERSION,
            "cases": list(plan_or_cases),
        }
    return _sha256(material)


def resolve_function(name: str) -> str:
    """Resolve a canonical function name or report-friendly alias."""

    if not isinstance(name, str) or not name.strip():
        raise ValueError("function names must be non-empty strings")
    wanted = name.strip()
    for candidate in CATALOG_ORDER:
        if candidate.casefold() == wanted.casefold():
            return candidate
    for alias, candidate in FUNCTION_ALIASES.items():
        if alias.casefold() == wanted.casefold():
            return candidate
    raise ValueError(f"unknown zsmooth function: {name}")


def resolve_format(name: str) -> str:
    if not isinstance(name, str) or not name.strip():
        raise ValueError("format names must be non-empty strings")
    wanted = name.strip().casefold()
    if wanted not in FORMAT_NAMES:
        raise ValueError(f"unknown benchmark format: {name}")
    return wanted


def _selected_names(functions: Iterable[str] | None) -> list[str]:
    if functions is None:
        return list(CATALOG_ORDER)
    selected: list[str] = []
    for function in functions:
        canonical = resolve_function(function)
        if canonical not in selected:
            selected.append(canonical)
    if not selected:
        raise ValueError("at least one function must be selected")
    return [name for name in CATALOG_ORDER if name in selected]


def _selected_formats(formats: Iterable[str] | None) -> list[str] | None:
    if formats is None:
        return None
    selected: list[str] = []
    for format_name in formats:
        canonical = resolve_format(format_name)
        if canonical not in selected:
            selected.append(canonical)
    if not selected:
        raise ValueError("at least one format must be selected")
    return selected


def build_cases(
    functions: Iterable[str] | None = None,
    formats: Iterable[str] | None = None,
    *,
    width: int = DEFAULT_WIDTH,
    height: int = DEFAULT_HEIGHT,
    length: int = DEFAULT_LENGTH,
    frame_count: int = DEFAULT_FRAME_COUNT,
) -> list[dict[str, Any]]:
    """Expand catalog capabilities into deterministic, JSON-safe plan cases."""

    if width < 1 or height < 1 or length < 1:
        raise ValueError("input width, height, and length must be positive")
    if frame_count < 1:
        raise ValueError("frame_count must be positive")
    if frame_count > length:
        raise ValueError("frame_count cannot exceed input length")

    names = _selected_names(functions)
    requested_formats = _selected_formats(formats)
    frame_start = (length - frame_count) // 2
    cases: list[dict[str, Any]] = []

    for function in names:
        capability = CATALOG[function]
        allowed_formats = [resolve_format(item) for item in capability["formats"]]
        chosen_formats = [
            format_name
            for format_name in (requested_formats or allowed_formats)
            if format_name in allowed_formats
        ]
        if requested_formats is not None and not chosen_formats:
            if len(names) == 1:
                raise ValueError(
                    f"no requested formats are supported by {function}: "
                    f"{', '.join(requested_formats)}"
                )
            continue
        for format_name in chosen_formats:
            for kwargs in capability["cases"]:
                case: dict[str, Any] = {
                    "function": function, "format": format_name,
                    "kwargs": copy.deepcopy(kwargs),
                    "input": {
                        "version": INPUT_VERSION, "width": width, "height": height,
                        "length": length, "frame_start": frame_start,
                        "reference": list(capability["reference_args"]),
                        "topology": capability["topology"],
                    },
                    "frame_count": frame_count,
                }
                case["id"] = case_id(case)
                cases.append(case)
    if requested_formats is not None and not cases:
        raise ValueError(
            "no requested formats are supported by selected functions: "
            f"{', '.join(requested_formats)}"
        )
    return cases


def build_plan(
    functions: Iterable[str] | None = None,
    formats: Iterable[str] | None = None,
    **input_options: int,
) -> dict[str, Any]:
    """Build a complete plan and its stable ID."""

    plan: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "catalog_version": CATALOG_VERSION,
        "namespace": "zsmooth",
        "cases": build_cases(functions, formats, **input_options),
    }
    plan["plan_id"] = plan_id(plan)
    return plan


iter_cases = build_cases
make_plan = build_plan

__all__ = [
    "CATALOG", "CATALOG_ORDER", "CATALOG_VERSION", "DEFAULT_FRAME_COUNT",
    "DEFAULT_HEIGHT", "DEFAULT_LENGTH", "DEFAULT_WIDTH", "FORMAT_NAMES",
    "FUNCTION_ALIASES", "INPUT_VERSION", "SCHEMA_VERSION", "build_cases",
    "build_plan", "canonical_json", "case_id", "iter_cases", "make_plan",
    "plan_id", "resolve_format", "resolve_function",
]
