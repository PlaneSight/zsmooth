"""CLI for discovering, planning, and timing generated zsmooth cases.

The module imports VapourSynth lazily. This is important because the plugin
search path must be configured before the first VapourSynth import.
"""

from __future__ import annotations

import argparse
import gc
import hashlib
import importlib
import json
import os
import platform
import sys
import time
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

try:  # Permit both ``python -m benchmarks.harness`` and direct execution.
    from .catalog import (
        CATALOG,
        CATALOG_ORDER,
        build_plan,
        canonical_json,
        resolve_format,
        resolve_function,
    )
    from .schema import (
        BenchmarkCase,
        BenchmarkPlan,
        BenchmarkResult,
        CaseInput,
        CaseResult,
        JsonObject,
        JsonValue,
        SCHEMA_VERSION,
        SampleStatistics,
        SchemaError,
    )
except ImportError:  # pragma: no cover - only used for direct script execution.
    from catalog import (  # type: ignore[no-redef]
        CATALOG,
        CATALOG_ORDER,
        build_plan,
        canonical_json,
        resolve_format,
        resolve_function,
    )
    from schema import (  # type: ignore[no-redef]
        BenchmarkCase,
        BenchmarkPlan,
        BenchmarkResult,
        CaseInput,
        CaseResult,
        JsonObject,
        JsonValue,
        SCHEMA_VERSION,
        SampleStatistics,
        SchemaError,
    )


FORMAT_CONSTANTS = {
    "u8": "YUV420P8",
    "u16": "YUV420P16",
    "f16": "YUV420PH",
    "f32": "YUV420PS",
}


class HarnessError(RuntimeError):
    """An actionable benchmark setup or execution failure."""


def _positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be an integer") from exc
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return parsed


def _string_value(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)


def _read_attr(obj: Any, name: str, *, call: bool = False) -> Any:
    try:
        value = getattr(obj, name)
    except AttributeError:
        return None
    if call and callable(value):
        try:
            return value()
        except TypeError:
            return value
    return value


def _iter_named(value: Any) -> Iterable[tuple[str | None, Any]]:
    """Normalize mapping, pair, and object iterators used by VS API versions."""

    if value is None:
        return
    if isinstance(value, Mapping):
        for key, item in value.items():
            yield _string_value(key), item
        return
    if isinstance(value, (str, bytes)):
        yield _string_value(value), value
        return
    try:
        iterator = iter(value)
    except TypeError:
        yield None, value
        return
    for item in iterator:
        if isinstance(item, (tuple, list)) and len(item) == 2:
            key, candidate = item
            if isinstance(key, (str, bytes)):
                yield _string_value(key), candidate
                continue
        yield None, item


def _plugin_namespace(plugin: Any, fallback: str | None = None) -> str:
    if fallback and fallback.casefold() == "zsmooth":
        return fallback
    for attr in ("namespace", "name", "id"):
        value = _read_attr(plugin, attr)
        if value is not None and not callable(value):
            text = _string_value(value)
            if text:
                return text
    return fallback or ""


def _plugin_functions(plugin: Any) -> list[tuple[str, Any]]:
    raw = _read_attr(plugin, "functions", call=True)
    if raw is None:
        raw = _read_attr(plugin, "function", call=True)
    found: list[tuple[str, Any]] = []
    for key, function in _iter_named(raw):
        name = key
        if name is None:
            for attr in ("name", "function_name"):
                candidate = _read_attr(function, attr)
                if candidate is not None and not callable(candidate):
                    name = _string_value(candidate)
                    break
        if name:
            found.append((name, function))
    found.sort(key=lambda item: item[0].casefold())
    return found


def _function_signature(function: Any) -> str:
    for attr in ("signature", "args", "_signature"):
        value = _read_attr(function, attr, call=True)
        if value is not None and not callable(value):
            if isinstance(value, (list, tuple)):
                return ";".join(_string_value(part) for part in value)
            return _string_value(value)
    return _string_value(function)


def _plugin_pairs(core: Any) -> list[tuple[str | None, Any]]:
    raw = _read_attr(core, "plugins", call=True)
    return list(_iter_named(raw))


def _find_zsmooth_plugin(core: Any) -> Any:
    candidates = _plugin_pairs(core)
    for key, plugin in candidates:
        namespace = _plugin_namespace(plugin, key)
        if namespace.casefold() == "zsmooth" or (key or "").casefold() == "zsmooth":
            return plugin
    # Some older Python wrappers expose the namespace as a core attribute but
    # return a less useful object from plugins(). Keep plugins() authoritative
    # while retaining this compatibility fallback.
    fallback = _read_attr(core, "zsmooth")
    if fallback is not None:
        return fallback
    raise HarnessError("VapourSynth core.plugins() did not expose namespace zsmooth")


def _plugin_info(plugin: Any) -> dict[str, Any]:
    info: dict[str, Any] = {"namespace": _plugin_namespace(plugin, "zsmooth")}
    for output_name, attrs in (
        ("id", ("id", "identifier")),
        ("name", ("name", "plugin_name")),
        ("version", ("version", "version_string")),
    ):
        for attr in attrs:
            value = _read_attr(plugin, attr, call=True)
            if value is None or callable(value):
                continue
            if isinstance(value, (str, int, float, bool)):
                info[output_name] = value
                break
    return info


def discover_functions(vs: Any) -> tuple[Any, dict[str, Any]]:
    """Discover zsmooth through ``core.plugins()`` and normalize API versions."""

    core = _core(vs)
    plugin = _find_zsmooth_plugin(core)
    functions = [
        {"name": name, "signature": _function_signature(function)}
        for name, function in _plugin_functions(plugin)
    ]
    if not functions:
        raise HarnessError("zsmooth was loaded but exposes no functions")
    result = {
        "schema_version": SCHEMA_VERSION,
        "namespace": "zsmooth",
        "plugin": _plugin_info(plugin),
        "functions": functions,
    }
    return plugin, result


def _core(vs: Any) -> Any:
    core = _read_attr(vs, "core")
    if core is None:
        getter = _read_attr(vs, "get_core")
        if callable(getter):
            core = getter()
    if core is None:
        raise HarnessError("VapourSynth did not provide a core")
    return core


def _load_vapoursynth(plugin_path: str | None) -> Any:
    # This assignment intentionally precedes importlib.import_module.
    if plugin_path:
        os.environ["VAPOURSYNTH_EXTRA_PLUGIN_PATH"] = str(
            Path(plugin_path).expanduser()
        )
    try:
        vs = importlib.import_module("vapoursynth")
    except Exception as exc:  # Keep the CLI error independent of subprocesses.
        raise HarnessError(f"unable to import VapourSynth: {exc}") from exc

    # The environment variable normally loads a directory of plugins. If a
    # caller supplies one shared-library path, explicitly load that path too.
    if plugin_path and Path(plugin_path).is_file():
        std = _read_attr(_core(vs), "std")
        loader = _read_attr(std, "LoadPlugin") if std is not None else None
        if callable(loader):
            try:
                loader(path=str(Path(plugin_path).expanduser()))
            except TypeError:
                loader(str(Path(plugin_path).expanduser()))
    return vs


def _write_json(path: str | Path, value: JsonObject) -> None:
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(canonical_json(value) + "\n", encoding="utf-8")


def _read_plan(path: str | Path) -> BenchmarkPlan:
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HarnessError(f"unable to read JSON plan {path}: {exc}") from exc
    try:
        return BenchmarkPlan.from_json(value)
    except SchemaError as exc:
        raise HarnessError(f"invalid benchmark plan: {exc}") from exc


def _validate_plan(plan: BenchmarkPlan) -> tuple[BenchmarkCase, ...]:
    for case in plan.cases:
        try:
            function = resolve_function(case.function)
            format_name = resolve_format(case.format)
        except ValueError as exc:
            raise HarnessError(f"invalid case function/format: {exc}") from exc
        if function != case.function or format_name != case.format:
            raise HarnessError("plan cases must use canonical function and format names")
        if format_name not in CATALOG[function].formats:
            raise HarnessError(f"{function} does not support format {format_name}")
    return plan.cases


def _format_constant(vs: Any, format_name: str) -> Any:
    constant_name = FORMAT_CONSTANTS[format_name]
    try:
        return getattr(vs, constant_name)
    except AttributeError as exc:
        raise HarnessError(f"VapourSynth lacks format constant {constant_name}") from exc


def _blank_color(format_name: str, reference: bool) -> list[int | float]:
    if format_name == "u8":
        return [128, 128, 128] if reference else [64, 128, 128]
    if format_name == "u16":
        return [32768, 32768, 32768] if reference else [16384, 32768, 32768]
    if format_name in ("f16", "f32"):
        return [0.5, 0.5, 0.5] if reference else [0.25, 0.5, 0.5]
    raise HarnessError(f"unknown format {format_name}")


def _blank_clip(
    vs: Any,
    core: Any,
    format_name: str,
    input_info: CaseInput,
    *,
    reference: bool,
) -> Any:
    std = _read_attr(core, "std")
    blank = _read_attr(std, "BlankClip") if std is not None else None
    if not callable(blank):
        raise HarnessError("VapourSynth core.std.BlankClip is unavailable")
    return blank(
        width=input_info.width,
        height=input_info.height,
        format=_format_constant(vs, format_name),
        length=input_info.length,
        color=_blank_color(format_name, reference),
    )


def _callable_for(plugin: Any, function_name: str) -> Any:
    function = _read_attr(plugin, function_name)
    if callable(function):
        return function
    for name, candidate in _plugin_functions(plugin):
        if name == function_name and callable(candidate):
            return candidate
    raise HarnessError(f"discovered zsmooth function {function_name} is not callable")


def _build_graph(vs: Any, plugin: Any, case: BenchmarkCase) -> tuple[Any, list[Any]]:
    core = _core(vs)
    source = _blank_clip(vs, core, case.format, case.input, reference=False)
    clips = [source]
    kwargs = dict(case.kwargs)
    for reference_name in case.input.reference_arguments:
        reference = _blank_clip(
            vs, core, case.format, case.input, reference=True
        )
        clips.append(reference)
        kwargs[reference_name] = reference
    function = _callable_for(plugin, case.function)
    try:
        output = function(source, **kwargs)
    except Exception as exc:
        raise HarnessError(
            f"{case.function} failed while building {case.format} graph: {exc}"
        ) from exc
    if output is None or not callable(_read_attr(output, "get_frame")):
        raise HarnessError(f"{case.function} did not return a video node")
    return output, clips


def _clear_cache(core: Any) -> None:
    clear = _read_attr(core, "clear_cache")
    if callable(clear):
        clear()


def _release_graph(vs: Any, node: Any, clips: list[Any]) -> None:
    # Object destruction and cache eviction are intentionally outside timers.
    del node
    clips.clear()
    gc.collect()
    _clear_cache(_core(vs))


def _direct_sample(vs: Any, plugin: Any, case: BenchmarkCase) -> float:
    core = _core(vs)
    _clear_cache(core)
    node, clips = _build_graph(vs, plugin, case)
    frame_number = case.input.frame_start + case.frame_count // 2
    try:
        start = time.perf_counter_ns()
        frame = node.get_frame(frame_number)
        elapsed = (time.perf_counter_ns() - start) / 1_000_000.0
        if frame is None:
            raise HarnessError(f"{case.function} returned no frame")
        del frame
        return elapsed
    finally:
        _release_graph(vs, node, clips)


def _stream_sample(vs: Any, plugin: Any, case: BenchmarkCase) -> float:
    core = _core(vs)
    _clear_cache(core)
    node, clips = _build_graph(vs, plugin, case)
    start_frame = case.input.frame_start
    frame_count = case.frame_count
    try:
        start = time.perf_counter_ns()
        frames = []
        for offset in range(frame_count):
            frame = node.get_frame(start_frame + offset)
            if frame is None:
                raise HarnessError(f"{case.function} returned no frame")
            frames.append(frame)
        elapsed = (time.perf_counter_ns() - start) / 1_000_000.0
        # Report a per-frame sample while retaining the sequential stream timing.
        del frames
        return elapsed / frame_count
    finally:
        _release_graph(vs, node, clips)


def _statistics(samples: list[float]) -> SampleStatistics:
    try:
        return SampleStatistics.from_samples(samples)
    except SchemaError as exc:
        raise HarnessError(f"invalid timing samples: {exc}") from exc


def _run_case(
    vs: Any,
    plugin: Any,
    case: BenchmarkCase,
    timing: str,
    iterations: int,
    warmup: int,
) -> CaseResult:
    sample = _direct_sample if timing == "direct" else _stream_sample
    for _ in range(warmup):
        sample(vs, plugin, case)
    samples = [sample(vs, plugin, case) for _ in range(iterations)]
    return CaseResult(identifier=case.identifier, statistics=_statistics(samples))


def _value_for_environment(value: Any) -> JsonValue:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple)):
        return [_value_for_environment(item) for item in value]
    if isinstance(value, Mapping):
        return {str(key): _value_for_environment(item) for key, item in value.items()}
    return str(value)


def _environment(vs: Any, plugin: Any, plugin_path: str) -> JsonObject:
    values: JsonObject = {
        "python": platform.python_version(),
        "python_implementation": platform.python_implementation(),
        "platform": platform.platform(),
        "vapoursynth": _value_for_environment(
            _read_attr(vs, "__version__") or _read_attr(vs, "VERSION")
        ),
        "plugin_path": str(Path(plugin_path).expanduser()),
        "plugin": _plugin_info(plugin),
    }
    # The build path is temporary and differs for each detached worktree. Keep
    # it in metadata, but exclude it from the stable environment identity.
    identity_values = {
        key: value for key, value in values.items() if key != "plugin_path"
    }
    values["id"] = hashlib.sha256(
        canonical_json(identity_values).encode("utf-8")
    ).hexdigest()
    return values


def _validate_discovery(discovery: Mapping[str, Any], functions: Iterable[str]) -> None:
    found = {
        str(item["name"]).casefold()
        for item in discovery.get("functions", [])
        if isinstance(item, Mapping) and "name" in item
    }
    missing = [
        function for function in functions
        if resolve_function(function).casefold() not in found
    ]
    if missing:
        raise HarnessError(
            "loaded zsmooth is missing catalog functions: " + ", ".join(missing)
        )


def _command_discover(arguments: argparse.Namespace) -> int:
    vs = _load_vapoursynth(arguments.plugin_path)
    _plugin, discovery = discover_functions(vs)
    print(canonical_json(discovery))
    return 0


def _command_plan(arguments: argparse.Namespace) -> int:
    selected_functions = arguments.function or list(CATALOG_ORDER)
    if arguments.plugin_path:
        vs = _load_vapoursynth(arguments.plugin_path)
        _plugin, discovery = discover_functions(vs)
        _validate_discovery(discovery, selected_functions)
    # build_plan resolves IQM and validates explicit format allowlists.
    plan = build_plan(selected_functions, arguments.format or None)
    _write_json(arguments.output, plan.to_json())
    return 0


def _command_run(arguments: argparse.Namespace) -> int:
    plan = _read_plan(arguments.plan)
    cases = _validate_plan(plan)
    vs = _load_vapoursynth(arguments.plugin_path)
    plugin, discovery = discover_functions(vs)
    _validate_discovery(discovery, [case.function for case in cases])
    results = [
        _run_case(
            vs, plugin, case, arguments.timing, arguments.iterations, arguments.warmup
        )
        for case in cases
    ]
    environment = _environment(vs, plugin, arguments.plugin_path)
    result = BenchmarkResult(
        plan_id=plan.identifier,
        timing=arguments.timing,
        config={
            "iterations": arguments.iterations,
            "warmup": arguments.warmup,
            "case_count": len(cases),
            "plugin_path": str(Path(arguments.plugin_path).expanduser()),
        },
        environment=environment,
        cases=tuple(results),
    )
    result.validate_plan(plan)
    _write_json(arguments.output, result.to_json())
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    discover = subparsers.add_parser("discover", help="discover loaded zsmooth functions")
    discover.add_argument("--plugin-path", required=True)
    discover.set_defaults(handler=_command_discover)

    plan = subparsers.add_parser("plan", help="write a deterministic benchmark plan")
    plan.add_argument("--output", required=True)
    plan.add_argument("--plugin-path")
    plan.add_argument("--function", action="append", default=[])
    plan.add_argument("--format", action="append", default=[])
    plan.set_defaults(handler=_command_plan)

    run = subparsers.add_parser("run", help="run cases from a benchmark plan")
    run.add_argument("--plugin-path", required=True)
    run.add_argument("--plan", required=True)
    run.add_argument("--output", required=True)
    run.add_argument("--timing", choices=("direct", "stream"), required=True)
    run.add_argument("--iterations", type=_positive_int, required=True)
    run.add_argument("--warmup", type=_positive_int, required=True)
    run.set_defaults(handler=_command_run)
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = _parser().parse_args(argv)
    try:
        return arguments.handler(arguments)
    except (HarnessError, OSError, ValueError, TypeError) as exc:
        print(f"harness error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
