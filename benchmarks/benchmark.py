#!/usr/bin/env python3
"""Build and measure immutable zsmooth revisions with the canonical harness."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    from .schema import (
        BenchmarkPlan,
        BenchmarkResult,
        ComparisonRow,
        ComparisonSummary,
        JsonObject,
        JsonValue,
        SCHEMA_VERSION,
        SchemaError,
    )
except ImportError:  # pragma: no cover - direct script execution.
    from schema import (  # type: ignore[no-redef]
        BenchmarkPlan,
        BenchmarkResult,
        ComparisonRow,
        ComparisonSummary,
        JsonObject,
        JsonValue,
        SCHEMA_VERSION,
        SchemaError,
    )

BUILD_COMMAND = ("zig", "build", "-Doptimize=ReleaseFast")
SOURCE_FUNCTIONS: dict[str, tuple[str, ...]] = {
    "src/ccd.zig": ("CCD",),
    "src/clense.zig": ("Clense", "ForwardClense", "BackwardClense"),
    "src/cnr4.zig": ("Cnr4",),
    "src/dctfilter.zig": ("DCTFilter",),
    "src/degrain_median.zig": ("DegrainMedian",),
    "src/fluxsmooth.zig": ("FluxSmoothT", "FluxSmoothST"),
    "src/inter_quartile_mean.zig": ("InterQuartileMean",),
    "src/median.zig": ("Median",),
    "src/remove_grain.zig": ("RemoveGrain",),
    "src/repair.zig": ("Repair",),
    "src/smart_median.zig": ("SmartMedian",),
    "src/temporal_median.zig": ("TemporalMedian",),
    "src/temporal_repair.zig": ("TemporalRepair",),
    "src/temporal_soften.zig": ("TemporalSoften",),
    "src/ttempsmooth.zig": ("TTempSmooth",),
    "src/vertical_cleaner.zig": ("VerticalCleaner",),
}
GLOBAL_CHANGE_FILES = {
    "build.zig", "build.zig.zon", "build.zig.lock", "build.zig.zon.lock",
    "zig.lock", "zig.mod", "zig.mod.zon", ".zig-version", "flake.lock",
    "flake.nix", "dockerfile", "makefile", "cmakelists.txt", "meson.build",
    "pyproject.toml", "hatch_build.py", "package.json", "setup.py", "setup.cfg",
    "tox.ini", "pipfile", "pipfile.lock", "cargo.toml", "cargo.lock",
    "go.mod", "go.sum", "gemfile", "gemfile.lock", "composer.json",
    "composer.lock", "environment.yml", "environment.yaml", ".tool-versions",
    ".python-version", ".node-version", ".nvmrc", "rust-toolchain",
    "rust-toolchain.toml", "zig-toolchain", "zig-toolchain.zig",
    "justfile", "taskfile.yml", "workspace", "workspace.bazel",
    "module.bazel", "bazel.lock", "gradle.lockfile",
    "benchmarks/catalog.py", "benchmarks/harness.py", "benchmarks/benchmark.py",
}
GLOBAL_CHANGE_DIRS = {
    "common", "dep", "deps", "dependency", "dependencies", "third_party",
    "toolchain", "vendor",
}
GLOBAL_CHANGE_MANIFESTS = {
    "bun.lock", "bun.lockb", "npm-shrinkwrap.json", "pnpm-lock.yaml",
    "yarn.lock", "poetry.lock", "pdm.lock", "uv.lock", "pipfile.lock",
    "packages.lock.json", "project.assets.json", "cargo.lock", "gemfile.lock",
    "composer.lock", "mix.lock",
}


class BenchmarkError(RuntimeError):
    pass


@dataclass(frozen=True)
class Revision:
    requested: str
    ref: str
    commit: str


@dataclass(frozen=True)
class Worktree:
    role: str
    revision: Revision
    path: Path
    plugin_path: Path


@dataclass(frozen=True)
class Timing:
    mode: str
    iterations: int
    warmup: int

    def as_dict(self) -> JsonObject:
        return {"mode": self.mode, "iterations": self.iterations, "warmup": self.warmup}


def _command_text(command: Sequence[str]) -> str:
    return " ".join(str(part) for part in command)


def run_command(command: Sequence[str], cwd: Path, *, env: Mapping[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    try:
        completed = subprocess.run(
            [str(part) for part in command], cwd=str(cwd), env=dict(env) if env is not None else None,
            text=True, capture_output=True, check=False,
        )
    except OSError as error:
        raise BenchmarkError(f"Unable to execute {_command_text(command)}: {error}") from error
    if completed.returncode:
        details = (completed.stderr or "").strip() or (completed.stdout or "").strip()
        suffix = f": {details}" if details else ""
        raise BenchmarkError(f"Command failed ({completed.returncode}): {_command_text(command)}{suffix}")
    return completed


def git_output(repo_root: Path, args: Sequence[str]) -> str:
    return (run_command(("git", *args), repo_root).stdout or "").strip()


def resolve_repo_root(start: Path | None = None) -> Path:
    return Path(git_output((start or Path.cwd()).resolve(), ("rev-parse", "--show-toplevel"))).resolve()


def _ref_candidates(requested: str) -> list[str]:
    values = [requested]
    if requested == "main":
        values.append("master")
    if not requested.startswith("origin/"):
        values.append(f"origin/{requested}")
    if requested == "main":
        values.append("origin/master")
    return list(dict.fromkeys(values))


def resolve_ref(repo_root: Path, requested: str) -> Revision:
    if not requested or requested.startswith("-"):
        raise BenchmarkError(f"Invalid revision reference: {requested!r}")
    for candidate in _ref_candidates(requested):
        try:
            output = git_output(repo_root, ("rev-parse", "--verify", f"{candidate}^{{commit}}"))
        except BenchmarkError:
            continue
        commit = output.splitlines()[-1].strip() if output else ""
        if len(commit) >= 40 and all(c in "0123456789abcdefABCDEF" for c in commit):
            return Revision(requested, candidate, commit.lower())
    raise BenchmarkError(f"Unable to resolve revision {requested!r}; tried {', '.join(_ref_candidates(requested))}")


def resolve_default_branch(repo_root: Path) -> str:
    candidates: list[str] = []
    try:
        remote_head = git_output(
            repo_root,
            ("symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"),
        )
    except BenchmarkError:
        remote_head = ""
    if remote_head:
        candidates.append(remote_head)

    # Prefer conventional default branches over the branch currently checked
    # out: compare is commonly invoked from a feature branch.
    candidates.extend(("main", "master"))
    try:
        configured = git_output(repo_root, ("config", "--get", "init.defaultBranch"))
    except BenchmarkError:
        configured = ""
    if configured:
        candidates.append(configured)

    # A local branch is useful as the final fallback for repositories that have
    # neither a remote HEAD nor a main/master branch.
    try:
        current = git_output(repo_root, ("symbolic-ref", "--quiet", "--short", "HEAD"))
    except BenchmarkError:
        current = ""
    if current:
        candidates.append(current)

    for candidate in dict.fromkeys(candidates):
        try:
            resolve_ref(repo_root, candidate)
        except BenchmarkError:
            continue
        return candidate
    return "HEAD"
def compute_merge_base(repo_root: Path, baseline: Revision, candidate: Revision) -> str:
    if baseline.commit == candidate.commit:
        raise BenchmarkError(
            f"Baseline and candidate resolve to the same commit: {baseline.commit}"
        )
    value = git_output(repo_root, ("merge-base", baseline.commit, candidate.commit))
    if not value:
        raise BenchmarkError(f"No merge-base exists between {baseline.commit} and {candidate.commit}")
    return value.splitlines()[-1].strip()


def changed_files(repo_root: Path, merge_base: str, candidate: Revision) -> list[str]:
    output = git_output(repo_root, ("diff", "--name-only", f"{merge_base}..{candidate.commit}", "--"))
    return [line.strip() for line in output.splitlines() if line.strip()]


def _pascal_function_name(stem: str) -> str:
    special = {"ccd": "CCD", "cnr4": "Cnr4", "dctfilter": "DCTFilter", "ttempsmooth": "TTempSmooth"}
    if stem in special:
        return special[stem]
    return "".join(part[:1].upper() + part[1:] for part in stem.split("_") if part)


def _is_global_change(path: str) -> bool:
    path = path.replace("\\", "/").strip("/")
    while path.startswith("./"):
        path = path[2:]
    normalized = path.casefold()
    if normalized in GLOBAL_CHANGE_FILES or normalized in GLOBAL_CHANGE_MANIFESTS:
        return True
    parts = normalized.split("/")
    basename = parts[-1] if parts else ""
    if any(part in GLOBAL_CHANGE_DIRS for part in parts):
        return True
    if (
        normalized == "common" or normalized.startswith("common/") or
        normalized == "src/common" or normalized.startswith("src/common/") or
        normalized == "src/zsmooth.zig" or
        normalized.startswith(".github/workflows/") or
        normalized.startswith(".buildkite/")
    ):
        return True
    if basename == "hatch_build.py":
        return True
    if basename.startswith("requirements") and basename.endswith((".txt", ".in")):
        return True
    if (
        "lock" in basename or basename.startswith(
            ("build.", "toolchain", "manifest", "dependency", "dependencies", "deps.")
        ) or basename in {"build", "dep", "deps", "dependency", "dependencies", "toolchain"}
    ):
        return True
    return False



def changed_function_candidates(changed: Iterable[str]) -> tuple[bool, set[str]]:
    all_functions = False
    functions: set[str] = set()
    for raw_path in changed:
        path = raw_path.replace("\\", "/").strip("/")
        if _is_global_change(path):
            all_functions = True
        if path == "src/zsmooth.zig":
            continue
        if path in SOURCE_FUNCTIONS:
            functions.update(SOURCE_FUNCTIONS[path])
        elif path.startswith("src/") and path.endswith(".zig") and "/" not in path[4:-4]:
            functions.add(_pascal_function_name(Path(path).stem))
    functions.discard("")
    return all_functions, functions


def _json_from_text(text: str) -> Any:
    text = text.strip()
    if not text:
        raise BenchmarkError("Harness produced no JSON output")
    try:
        return json.loads(text)
    except json.JSONDecodeError as first:
        for index in reversed([i for i, char in enumerate(text) if char in "[{]"]):
            try:
                return json.loads(text[index:])
            except json.JSONDecodeError:
                pass
        raise BenchmarkError(f"Harness output was not valid JSON: {first}") from first


def _names_from_discovery(value: Any) -> set[str]:
    if isinstance(value, str):
        return {value}
    if isinstance(value, (list, tuple, set)):
        names: set[str] = set()
        for item in value:
            names.update(_names_from_discovery(item))
        return names
    if not isinstance(value, Mapping):
        return set()
    for key in ("functions", "discovered_functions", "catalog", "entries"):
        if key in value:
            return _names_from_discovery(value[key])
    for key in ("function", "name"):
        if isinstance(value.get(key), str):
            return {value[key]}
    return {key for key, item in value.items() if isinstance(key, str) and isinstance(item, Mapping)}


def harness_path(repo_root: Path) -> Path:
    path = repo_root / "benchmarks" / "harness.py"
    if not path.is_file():
        raise BenchmarkError(f"Canonical harness is missing from original checkout: {path}")
    return path


def python_runtime(requested: str | None) -> str:
    return requested or os.environ.get("VAPOURSYNTH_PYTHON") or sys.executable


def _harness_environment(plugin_path: Path) -> dict[str, str]:
    environment = dict(os.environ)
    old = environment.get("VAPOURSYNTH_EXTRA_PLUGIN_PATH", "")
    environment["VAPOURSYNTH_EXTRA_PLUGIN_PATH"] = os.pathsep.join(
        [str(plugin_path)] + ([old] if old else [])
    )
    return environment


def invoke_discover(repo_root: Path, runtime: str, plugin_path: Path) -> set[str]:
    command = (runtime, str(harness_path(repo_root)), "discover", "--plugin-path", str(plugin_path))
    completed = run_command(command, repo_root, env=_harness_environment(plugin_path))
    return _names_from_discovery(_json_from_text(completed.stdout or ""))


def _validate_plan(value: object) -> BenchmarkPlan:
    try:
        return BenchmarkPlan.from_json(value)
    except SchemaError as exc:
        raise BenchmarkError(f"Malformed harness plan: {exc}") from exc


def invoke_plan(
    repo_root: Path,
    runtime: str,
    plugin_path: Path,
    output_path: Path,
    *,
    functions: Sequence[str] | None = None,
    formats: Sequence[str] | None = None,
) -> BenchmarkPlan:
    command = [runtime, str(harness_path(repo_root)), "plan", "--output", str(output_path), "--plugin-path", str(plugin_path)]
    if functions is not None:
        for function in functions:
            command.extend(("--function", function))
    for format_name in formats or ():
        command.extend(("--format", format_name))
    run_command(command, repo_root, env=_harness_environment(plugin_path))
    if not output_path.is_file():
        raise BenchmarkError(f"Harness did not write plan: {output_path}")
    try:
        plan = json.loads(output_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise BenchmarkError(f"Unable to read harness plan {output_path}: {error}") from error
    return _validate_plan(plan)


def _validate_result(
    value: object,
    plan: BenchmarkPlan,
    timing: Timing | None = None,
) -> BenchmarkResult:
    try:
        result = BenchmarkResult.from_json(value)
        result.validate_plan(plan)
    except SchemaError as exc:
        raise BenchmarkError(f"Malformed harness result: {exc}") from exc
    if timing is not None and result.timing != timing.mode:
        raise BenchmarkError(
            f"Result timing {result.timing!r} does not match {timing.mode!r}"
        )
    return result


def invoke_run(
    repo_root: Path,
    runtime: str,
    plugin_path: Path,
    plan_path: Path,
    output_path: Path,
    timing: Timing,
    plan: BenchmarkPlan,
) -> BenchmarkResult:
    command = [runtime, str(harness_path(repo_root)), "run", "--plugin-path", str(plugin_path), "--plan", str(plan_path), "--output", str(output_path), "--timing", timing.mode, "--iterations", str(timing.iterations), "--warmup", str(timing.warmup)]
    run_command(command, repo_root, env=_harness_environment(plugin_path))
    if not output_path.is_file():
        raise BenchmarkError(f"Harness did not write result: {output_path}")
    try:
        result = json.loads(output_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise BenchmarkError(f"Unable to read harness result {output_path}: {error}") from error
    return _validate_result(result, plan, timing)


def verify_plugin(plugin_path: Path) -> None:
    if not plugin_path.is_dir():
        raise BenchmarkError(f"Build did not produce zsmooth library directory: {plugin_path}")
    known = ("libzsmooth.so", "libzsmooth.dylib", "libzsmooth.dll", "zsmooth.dll")
    if any((plugin_path / name).is_file() for name in known):
        return
    if any(path.is_file() and "zsmooth" in path.name.lower() and path.suffix.lower() in {".so", ".dylib", ".dll"} for path in plugin_path.iterdir()):
        return
    raise BenchmarkError(f"Build did not produce a zsmooth library in {plugin_path}")


def cleanup_worktrees(repo_root: Path, worktrees: Sequence[Path], temp_root: Path) -> None:
    for path in worktrees:
        try:
            run_command(("git", "worktree", "remove", "--force", str(path)), repo_root)
        except BenchmarkError as error:
            print(str(error), file=sys.stderr)
    try:
        run_command(("git", "worktree", "prune"), repo_root)
    except BenchmarkError as error:
        print(str(error), file=sys.stderr)
    shutil.rmtree(temp_root, ignore_errors=True)


def environment_snapshot(runtime: str) -> JsonObject:
    return {
        "platform": platform.platform(), "system": platform.system(), "release": platform.release(),
        "machine": platform.machine(), "processor": platform.processor(),
        "python_implementation": platform.python_implementation(), "python_version": platform.python_version(),
        "python_runtime": str(runtime), "vapoursynth_python": os.environ.get("VAPOURSYNTH_PYTHON"),
        "extra_plugin_path": os.environ.get("VAPOURSYNTH_EXTRA_PLUGIN_PATH"),
    }


def environment_id(environment: Mapping[str, JsonValue]) -> str:
    stable = {key: value for key, value in environment.items() if key != "extra_plugin_path"}
    digest = hashlib.sha256(json.dumps(stable, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:12]
    version = str(environment.get("python_version", "0")).split(".")
    label = f"{str(environment.get('system', 'unknown')).lower()}-{str(environment.get('machine', 'unknown')).lower()}-py{''.join(version[:2])}-{digest}"
    return "".join(char if char.isalnum() or char in "-._" else "_" for char in label)


def _result_environment(result: BenchmarkResult) -> tuple[JsonObject, str]:
    metadata = dict(result.environment)
    identifier = metadata.get("id")
    if isinstance(identifier, str) and identifier:
        return metadata, identifier
    return metadata, environment_id(metadata)


def _comparison_environment(
    baseline_result: BenchmarkResult | None,
    candidate_result: BenchmarkResult | None,
    fallback: JsonObject,
) -> tuple[JsonObject, str]:
    # Prefer the candidate result, then baseline, so role order makes fallback
    # behavior deterministic when both harness runs expose metadata.
    for result in (candidate_result, baseline_result):
        if result is not None:
            return _result_environment(result)
    metadata = dict(fallback)
    identifier = metadata.get("id")
    if isinstance(identifier, str) and identifier:
        return metadata, identifier
    return metadata, environment_id(metadata)


def build_config() -> dict[str, Any]:
    return {"command": list(BUILD_COMMAND), "optimize": "ReleaseFast", "detached_worktrees": True}


def _write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")


def _persist_raw_artifacts(output: Path, artifacts: Mapping[str, Path]) -> dict[str, str]:
    destination_root = output.with_name(output.stem + ".raw")
    destination_root.mkdir(parents=True, exist_ok=True)
    persisted: dict[str, str] = {}
    for name, source in artifacts.items():
        destination = destination_root / name
        shutil.copy2(source, destination)
        persisted[name] = str(destination)
    return persisted


def _output_path(repo_root: Path, requested: str | None, default: Path) -> Path:
    path = Path(requested) if requested else default
    return path if path.is_absolute() else repo_root / path


def _revision_json(revision: Revision) -> dict[str, str]:
    return {"requested": revision.requested, "resolved_ref": revision.ref, "commit": revision.commit}


def _timing_from_args(args: argparse.Namespace) -> Timing:
    if args.iterations < 3:
        raise BenchmarkError("--iterations must be an integer of at least 3")
    if args.warmup <= 0:
        raise BenchmarkError("--warmup must be a positive integer")
    return Timing(args.timing, args.iterations, args.warmup)




def compare_cases(
    plan: BenchmarkPlan | None,
    baseline_result: BenchmarkResult | None,
    candidate_result: BenchmarkResult | None,
    added_functions: Sequence[str],
    removed_functions: Sequence[str],
) -> tuple[list[ComparisonRow], ComparisonSummary]:
    baseline_by_id = (
        {case.identifier: case for case in baseline_result.cases}
        if baseline_result is not None
        else {}
    )
    candidate_by_id = (
        {case.identifier: case for case in candidate_result.cases}
        if candidate_result is not None
        else {}
    )
    rows: list[ComparisonRow] = []
    for plan_case in plan.cases if plan is not None else ():
        case_id = plan_case.identifier
        try:
            baseline_median = baseline_by_id[case_id].statistics.median_ms
            candidate_median = candidate_by_id[case_id].statistics.median_ms
        except KeyError as exc:
            raise BenchmarkError(f"Case {case_id} is missing from a benchmark result") from exc
        rows.append(
            ComparisonRow(
                status="comparable",
                identifier=case_id,
                function=plan_case.function,
                format=plan_case.format,
                baseline_median_ms=baseline_median,
                candidate_median_ms=candidate_median,
            )
        )
    for function in sorted(set(added_functions)):
        rows.append(ComparisonRow(status="added", function=function))
    for function in sorted(set(removed_functions)):
        rows.append(ComparisonRow(status="removed", function=function))
    ratios = [ratio for row in rows if (ratio := row.ratio) is not None]
    geometric_ratio = math.exp(sum(math.log(value) for value in ratios) / len(ratios)) if ratios else None
    return rows, ComparisonSummary(
        comparable_cases=len(ratios),
        added_functions=len(set(added_functions)),
        removed_functions=len(set(removed_functions)),
        geometric_ratio=geometric_ratio,
    )


def _common_functions(all_functions: bool, mapped: set[str], baseline: set[str], candidate: set[str]) -> tuple[list[str], list[str], list[str]]:
    scope = baseline | candidate if all_functions else mapped
    return sorted(scope & baseline & candidate), sorted(scope & candidate - baseline), sorted(scope & baseline - candidate)


def run_reference(args: argparse.Namespace) -> int:
    repo_root = resolve_repo_root()
    runtime = python_runtime(args.python_runtime)
    timing = _timing_from_args(args)
    revision = resolve_ref(repo_root, args.ref_option or args.ref_pos or "HEAD")
    temp_root = Path(tempfile.mkdtemp(prefix="zsmooth-benchmark-"))
    worktree_paths: list[Path] = []
    try:
        path = temp_root / "reference"
        run_command(("git", "worktree", "add", "--detach", str(path), revision.commit), repo_root)
        worktree_paths.append(path)
        run_command(BUILD_COMMAND, path)
        plugin_path = path / "zig-out" / "lib"
        verify_plugin(plugin_path)
        plan_path, result_path = temp_root / "reference-plan.json", temp_root / "reference-result.json"
        plan = invoke_plan(repo_root, runtime, plugin_path, plan_path)
        result = invoke_run(repo_root, runtime, plugin_path, plan_path, result_path, timing, plan)
        environment, env_id = _result_environment(result)
        output = _output_path(repo_root, args.output, repo_root / "benchmarks" / "references" / env_id / f"{revision.commit}.json")
        raw_paths = _persist_raw_artifacts(
            output,
            {"reference-plan.json": plan_path, "reference-result.json": result_path},
        )
        _write_json(output, {"schema_version": SCHEMA_VERSION, "kind": "benchmark-reference", "catalog_version": plan.catalog_version, "plan_id": plan.identifier, "merge_base": None, "requested_refs": {"reference": revision.requested}, "resolved_refs": {"reference": _revision_json(revision)}, "changed_files": [], "changed_functions": [], "timing": timing.as_dict(), "build_config": build_config(), "environment_id": env_id, "environment": environment, "raw_result_paths": {"reference": raw_paths["reference-result.json"]}, "raw_plan_path": raw_paths["reference-plan.json"], "cases": [case.to_json() for case in result.cases], "result": result.to_json()})
        print(f"Wrote reference benchmark for {revision.commit} to {output}")
        return 0
    finally:
        if not args.keep_worktrees:
            cleanup_worktrees(repo_root, worktree_paths, temp_root)
        else:
            print(f"Kept temporary benchmark root at {temp_root}")


def run_compare(args: argparse.Namespace) -> int:
    repo_root = resolve_repo_root()
    runtime = python_runtime(args.python_runtime)
    timing = _timing_from_args(args)
    candidate_requested = args.candidate_option or args.candidate_pos or "HEAD"
    baseline_requested = args.baseline_option or args.baseline_pos or resolve_default_branch(repo_root)
    candidate, baseline = resolve_ref(repo_root, candidate_requested), resolve_ref(repo_root, baseline_requested)
    if candidate.commit == baseline.commit:
        raise BenchmarkError(
            f"Baseline and candidate resolve to the same commit: {candidate.commit}"
        )
    merge_base = compute_merge_base(repo_root, baseline, candidate)
    files = changed_files(repo_root, merge_base, candidate)
    all_functions, mapped = changed_function_candidates(files)
    environment = environment_snapshot(runtime)
    output = _output_path(repo_root, args.output, repo_root / "benchmarks" / "results" / f"{candidate.commit}.json")
    temp_root = Path(tempfile.mkdtemp(prefix="zsmooth-benchmark-"))
    worktree_paths: list[Path] = []
    worktrees: dict[str, Worktree] = {}
    baseline_worktree = Revision(baseline.requested, merge_base, merge_base)
    try:
        for role, revision in (("baseline", baseline_worktree), ("candidate", candidate)):
            path = temp_root / role
            run_command(("git", "worktree", "add", "--detach", str(path), revision.commit), repo_root)
            worktree_paths.append(path)
            run_command(BUILD_COMMAND, path)
            plugin_path = path / "zig-out" / "lib"
            verify_plugin(plugin_path)
            worktrees[role] = Worktree(role, revision, path, plugin_path)
        baseline_functions = invoke_discover(repo_root, runtime, worktrees["baseline"].plugin_path)
        candidate_functions = invoke_discover(repo_root, runtime, worktrees["candidate"].plugin_path)
        common, added, removed = _common_functions(all_functions, mapped, baseline_functions, candidate_functions)
        changed = sorted((baseline_functions | candidate_functions) if all_functions else mapped)
        plan_path, baseline_path, candidate_path = temp_root / "compare-plan.json", temp_root / "baseline-result.json", temp_root / "candidate-result.json"
        if common:
            plan = invoke_plan(repo_root, runtime, worktrees["candidate"].plugin_path, plan_path, functions=common, formats=args.formats)
            baseline_result = invoke_run(repo_root, runtime, worktrees["baseline"].plugin_path, plan_path, baseline_path, timing, plan)
            candidate_result = invoke_run(repo_root, runtime, worktrees["candidate"].plugin_path, plan_path, candidate_path, timing, plan)
            raw_paths = _persist_raw_artifacts(
                output,
                {
                    "compare-plan.json": plan_path,
                    "baseline-result.json": baseline_path,
                    "candidate-result.json": candidate_path,
                },
            )
        else:
            plan = None
            baseline_result = None
            candidate_result = None
            raw_paths = None
        rows, summary = compare_cases(plan, baseline_result, candidate_result, added, removed)
        environment, env_id = _comparison_environment(baseline_result, candidate_result, environment)
        report_catalog_version = plan.catalog_version if plan is not None else None
        report_plan_id = plan.identifier if plan is not None else None
        report_raw_results = (
            {
                "baseline": raw_paths["baseline-result.json"],
                "candidate": raw_paths["candidate-result.json"],
            }
            if raw_paths is not None
            else {"baseline": None, "candidate": None}
        )
        report_raw_plan = raw_paths["compare-plan.json"] if raw_paths is not None else None
        report = {"schema_version": SCHEMA_VERSION, "kind": "benchmark-comparison", "catalog_version": report_catalog_version, "plan_id": report_plan_id, "merge_base": merge_base, "requested_refs": {"baseline": baseline.requested, "candidate": candidate.requested}, "resolved_refs": {"baseline": _revision_json(baseline), "candidate": _revision_json(candidate)}, "changed_files": files, "changed_functions": changed, "added_functions": added, "removed_functions": removed, "timing": timing.as_dict(), "build_config": build_config(), "environment_id": env_id, "environment": environment, "raw_result_paths": report_raw_results, "raw_plan_path": report_raw_plan, "cases": [row.to_json() for row in rows], "summary": summary.to_json()}
        _write_json(output, report)
        print(f"Compared {summary.comparable_cases} cases (geometric ratio: {summary.geometric_ratio!r}); wrote {output}")
        return 0
    finally:
        if not args.keep_worktrees:
            cleanup_worktrees(repo_root, worktree_paths, temp_root)
        else:
            print(f"Kept temporary benchmark root at {temp_root}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build immutable zsmooth revisions and run the canonical benchmark harness.")
    subparsers = parser.add_subparsers(dest="command", required=True)
    reference = subparsers.add_parser("reference", help="build one revision and run the complete catalog")
    reference.add_argument("ref_pos", nargs="?", help="revision to benchmark (default: HEAD)")
    reference.add_argument("--ref", dest="ref_option")
    reference.add_argument("--python", "--python-runtime", dest="python_runtime")
    reference.add_argument("--iterations", type=int, default=7)
    reference.add_argument("--warmup", type=int, default=1)
    reference.add_argument("--timing", choices=("direct", "stream"), default="direct")
    reference.add_argument("--output")
    reference.add_argument("--keep-worktrees", action="store_true")
    compare = subparsers.add_parser("compare", help="compare changed functions against the default/baseline branch")
    compare.add_argument("candidate_pos", nargs="?", help="candidate revision (default: HEAD)")
    compare.add_argument("baseline_pos", nargs="?", help="optional baseline revision")
    compare.add_argument("--candidate", dest="candidate_option")
    compare.add_argument("--baseline", dest="baseline_option")
    compare.add_argument("--python", "--python-runtime", dest="python_runtime")
    compare.add_argument("--iterations", type=int, default=7)
    compare.add_argument("--warmup", type=int, default=1)
    compare.add_argument("--timing", choices=("direct", "stream"), default="direct")
    compare.add_argument("--format", dest="formats", action="append", default=[])
    compare.add_argument("--output")
    compare.add_argument("--keep-worktrees", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return run_reference(args) if args.command == "reference" else run_compare(args)
    except (BenchmarkError, OSError, ValueError) as error:
        print(f"benchmark: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
