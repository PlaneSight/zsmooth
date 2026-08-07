"""Typed, versioned JSON contracts for the benchmark pipeline.

The benchmark commands communicate through JSON files because their build and
measurement phases run in separate detached worktrees.  These models keep that
boundary explicit: parsing validates untrusted JSON once, and the rest of the
pipeline uses immutable domain values instead of nested dictionaries.
"""

from __future__ import annotations

import hashlib
import json
import math
import statistics
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import TypeAlias, cast


SCHEMA_VERSION = 1
CATALOG_VERSION = "1"
INPUT_VERSION = 1

JsonPrimitive: TypeAlias = str | int | float | bool | None
JsonValue: TypeAlias = JsonPrimitive | list["JsonValue"] | dict[str, "JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]


class SchemaError(ValueError):
    """A JSON document does not conform to a benchmark contract."""


def canonical_json(value: JsonValue) -> str:
    """Serialize a JSON value deterministically for persisted IDs and files."""

    return json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def _stable_id(value: JsonValue) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _object(value: object, context: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise SchemaError(f"{context} must be an object")
    return cast(Mapping[str, object], value)


def _string(value: object, context: str) -> str:
    if not isinstance(value, str) or not value:
        raise SchemaError(f"{context} must be a non-empty string")
    return value


def _integer(value: object, context: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise SchemaError(f"{context} must be an integer of at least {minimum}")
    return value


def _number(value: object, context: str, *, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SchemaError(f"{context} must be a number")
    number = float(value)
    if not math.isfinite(number) or (positive and number <= 0):
        qualifier = "a finite positive number" if positive else "a finite number"
        raise SchemaError(f"{context} must be {qualifier}")
    return number


def _json_value(value: object, context: str) -> JsonValue:
    try:
        # This rejects unsupported values and non-finite floats while retaining
        # normal JSON's values and nesting semantics.
        return cast(JsonValue, json.loads(canonical_json(cast(JsonValue, value))))
    except (TypeError, ValueError) as exc:
        raise SchemaError(f"{context} must be JSON-compatible") from exc


def _json_object(value: object, context: str) -> JsonObject:
    parsed = _json_value(value, context)
    if not isinstance(parsed, dict):
        raise SchemaError(f"{context} must be a JSON object")
    return parsed


@dataclass(frozen=True, slots=True)
class CaseInput:
    """Deterministic input clip geometry shared by a benchmark case."""

    width: int
    height: int
    length: int
    frame_start: int
    reference_arguments: tuple[str, ...]
    topology: str
    version: int = INPUT_VERSION

    def __post_init__(self) -> None:
        if self.version != INPUT_VERSION:
            raise SchemaError(f"unsupported case input version: {self.version}")
        for name, value in (
            ("width", self.width),
            ("height", self.height),
            ("length", self.length),
        ):
            _integer(value, name, minimum=1)
        _integer(self.frame_start, "frame_start")
        if self.frame_start >= self.length:
            raise SchemaError("frame_start must be inside the input length")
        _string(self.topology, "topology")
        if any(not isinstance(name, str) or not name for name in self.reference_arguments):
            raise SchemaError("reference arguments must contain non-empty strings")

    def to_json(self) -> JsonObject:
        return {
            "version": self.version,
            "width": self.width,
            "height": self.height,
            "length": self.length,
            "frame_start": self.frame_start,
            "reference": list(self.reference_arguments),
            "topology": self.topology,
        }

    @classmethod
    def from_json(cls, value: object) -> CaseInput:
        data = _object(value, "case input")
        references = data.get("reference")
        if not isinstance(references, list):
            raise SchemaError("case input reference must be an array")
        return cls(
            version=_integer(data.get("version"), "case input version", minimum=1),
            width=_integer(data.get("width"), "case input width", minimum=1),
            height=_integer(data.get("height"), "case input height", minimum=1),
            length=_integer(data.get("length"), "case input length", minimum=1),
            frame_start=_integer(data.get("frame_start"), "case input frame_start"),
            reference_arguments=tuple(
                _string(item, "case input reference item") for item in references
            ),
            topology=_string(data.get("topology"), "case input topology"),
        )


@dataclass(frozen=True, slots=True)
class BenchmarkCase:
    """One fully specified plugin invocation and measurement range."""

    function: str
    format: str
    kwargs: JsonObject
    input: CaseInput
    frame_count: int
    identifier: str = ""

    def __post_init__(self) -> None:
        _string(self.function, "function")
        _string(self.format, "format")
        _json_object(self.kwargs, "case kwargs")
        _integer(self.frame_count, "frame_count", minimum=1)
        if self.input.frame_start + self.frame_count > self.input.length:
            raise SchemaError("case frame range exceeds the input length")
        expected = self.expected_identifier()
        if self.identifier and self.identifier != expected:
            raise SchemaError(
                f"case id does not match canonical content for {self.function}/{self.format}"
            )
        object.__setattr__(self, "identifier", expected)

    def identity_payload(self) -> JsonObject:
        return {
            "function": self.function,
            "format": self.format,
            "kwargs": self.kwargs,
            "input": self.input.to_json(),
            "frame_count": self.frame_count,
        }

    def expected_identifier(self) -> str:
        return _stable_id(self.identity_payload())

    def to_json(self) -> JsonObject:
        return {**self.identity_payload(), "id": self.identifier}

    @classmethod
    def from_json(cls, value: object) -> BenchmarkCase:
        data = _object(value, "benchmark case")
        return cls(
            function=_string(data.get("function"), "case function"),
            format=_string(data.get("format"), "case format"),
            kwargs=_json_object(data.get("kwargs"), "case kwargs"),
            input=CaseInput.from_json(data.get("input")),
            frame_count=_integer(data.get("frame_count"), "case frame_count", minimum=1),
            identifier=_string(data.get("id"), "case id"),
        )


@dataclass(frozen=True, slots=True)
class BenchmarkPlan:
    """The exact cases a harness process must execute."""

    cases: tuple[BenchmarkCase, ...]
    namespace: str = "zsmooth"
    catalog_version: str = CATALOG_VERSION
    schema_version: int = SCHEMA_VERSION
    identifier: str = ""

    def __post_init__(self) -> None:
        if self.schema_version != SCHEMA_VERSION:
            raise SchemaError(f"unsupported plan schema version: {self.schema_version}")
        if self.catalog_version != CATALOG_VERSION:
            raise SchemaError(f"unsupported catalog version: {self.catalog_version}")
        _string(self.namespace, "plan namespace")
        if not self.cases:
            raise SchemaError("plan must contain at least one case")
        identifiers = [case.identifier for case in self.cases]
        if len(identifiers) != len(set(identifiers)):
            raise SchemaError("plan contains duplicate case ids")
        expected = self.expected_identifier()
        if self.identifier and self.identifier != expected:
            raise SchemaError("plan_id does not match canonical plan content")
        object.__setattr__(self, "identifier", expected)

    def identity_payload(self) -> JsonObject:
        return {
            "schema_version": self.schema_version,
            "catalog_version": self.catalog_version,
            "namespace": self.namespace,
            "cases": [case.to_json() for case in self.cases],
        }

    def expected_identifier(self) -> str:
        return _stable_id(self.identity_payload())

    def to_json(self) -> JsonObject:
        return {**self.identity_payload(), "plan_id": self.identifier}

    @classmethod
    def from_json(cls, value: object) -> BenchmarkPlan:
        data = _object(value, "benchmark plan")
        cases = data.get("cases")
        if not isinstance(cases, list):
            raise SchemaError("plan cases must be an array")
        return cls(
            schema_version=_integer(data.get("schema_version"), "plan schema_version", minimum=1),
            catalog_version=_string(data.get("catalog_version"), "plan catalog_version"),
            namespace=_string(data.get("namespace"), "plan namespace"),
            cases=tuple(BenchmarkCase.from_json(case) for case in cases),
            identifier=_string(data.get("plan_id"), "plan_id"),
        )


@dataclass(frozen=True, slots=True)
class SampleStatistics:
    """A case's timing samples and derived metrics, all in milliseconds."""

    samples_ms: tuple[float, ...]
    mean_ms: float
    median_ms: float
    min_ms: float
    max_ms: float
    median_fps: float

    @classmethod
    def from_samples(cls, samples: Iterable[float]) -> SampleStatistics:
        values = tuple(_number(sample, "sample", positive=True) for sample in samples)
        if not values:
            raise SchemaError("at least one timing sample is required")
        median_ms = statistics.median(values)
        return cls(
            samples_ms=values,
            mean_ms=statistics.fmean(values),
            median_ms=median_ms,
            min_ms=min(values),
            max_ms=max(values),
            median_fps=1_000.0 / median_ms,
        )

    def __post_init__(self) -> None:
        if not self.samples_ms:
            raise SchemaError("at least one timing sample is required")
        for name, value in (
            ("mean_ms", self.mean_ms),
            ("median_ms", self.median_ms),
            ("min_ms", self.min_ms),
            ("max_ms", self.max_ms),
            ("median_fps", self.median_fps),
        ):
            _number(value, name, positive=True)
        if any(not math.isfinite(sample) or sample <= 0 for sample in self.samples_ms):
            raise SchemaError("timing samples must be finite and positive")

    def to_json(self) -> JsonObject:
        return {
            "samples_ms": list(self.samples_ms),
            "mean_ms": self.mean_ms,
            "median_ms": self.median_ms,
            "min_ms": self.min_ms,
            "max_ms": self.max_ms,
            "median_fps": self.median_fps,
        }

    @classmethod
    def from_json(cls, value: object) -> SampleStatistics:
        data = _object(value, "case statistics")
        samples = data.get("samples_ms")
        if not isinstance(samples, list):
            raise SchemaError("case statistics samples_ms must be an array")
        return cls(
            samples_ms=tuple(_number(sample, "timing sample", positive=True) for sample in samples),
            mean_ms=_number(data.get("mean_ms"), "mean_ms", positive=True),
            median_ms=_number(data.get("median_ms"), "median_ms", positive=True),
            min_ms=_number(data.get("min_ms"), "min_ms", positive=True),
            max_ms=_number(data.get("max_ms"), "max_ms", positive=True),
            median_fps=_number(data.get("median_fps"), "median_fps", positive=True),
        )


@dataclass(frozen=True, slots=True)
class CaseResult:
    identifier: str
    statistics: SampleStatistics

    def __post_init__(self) -> None:
        _string(self.identifier, "result case id")

    def to_json(self) -> JsonObject:
        return {"id": self.identifier, **self.statistics.to_json()}

    @classmethod
    def from_json(cls, value: object) -> CaseResult:
        data = _object(value, "benchmark result case")
        return cls(
            identifier=_string(data.get("id"), "result case id"),
            statistics=SampleStatistics.from_json(data),
        )


@dataclass(frozen=True, slots=True)
class BenchmarkResult:
    """A completed harness run for one immutable benchmark plan."""

    plan_id: str
    timing: str
    config: JsonObject
    environment: JsonObject
    cases: tuple[CaseResult, ...]
    schema_version: int = SCHEMA_VERSION
    kind: str = "benchmark"

    def __post_init__(self) -> None:
        if self.schema_version != SCHEMA_VERSION:
            raise SchemaError(f"unsupported result schema version: {self.schema_version}")
        if self.kind != "benchmark":
            raise SchemaError(f"unsupported benchmark result kind: {self.kind}")
        _string(self.plan_id, "result plan_id")
        if self.timing not in {"direct", "stream"}:
            raise SchemaError(f"unsupported benchmark timing: {self.timing}")
        _json_object(self.config, "result config")
        _json_object(self.environment, "result environment")
        identifiers = [case.identifier for case in self.cases]
        if len(identifiers) != len(set(identifiers)):
            raise SchemaError("result contains duplicate case ids")

    def validate_plan(self, plan: BenchmarkPlan) -> None:
        if self.plan_id != plan.identifier:
            raise SchemaError(
                f"result plan_id {self.plan_id!r} does not match {plan.identifier!r}"
            )
        expected = {case.identifier for case in plan.cases}
        actual = {case.identifier for case in self.cases}
        if expected != actual:
            raise SchemaError(
                "result case ids do not match the plan "
                f"(missing={sorted(expected - actual)}, unexpected={sorted(actual - expected)})"
            )

    def to_json(self) -> JsonObject:
        return {
            "schema_version": self.schema_version,
            "kind": self.kind,
            "plan_id": self.plan_id,
            "timing": self.timing,
            "config": self.config,
            "environment": self.environment,
            "cases": [case.to_json() for case in self.cases],
        }

    @classmethod
    def from_json(cls, value: object) -> BenchmarkResult:
        data = _object(value, "benchmark result")
        cases = data.get("cases")
        if not isinstance(cases, list):
            raise SchemaError("result cases must be an array")
        return cls(
            schema_version=_integer(data.get("schema_version"), "result schema_version", minimum=1),
            kind=_string(data.get("kind"), "result kind"),
            plan_id=_string(data.get("plan_id"), "result plan_id"),
            timing=_string(data.get("timing"), "result timing"),
            config=_json_object(data.get("config"), "result config"),
            environment=_json_object(data.get("environment"), "result environment"),
            cases=tuple(CaseResult.from_json(case) for case in cases),
        )


@dataclass(frozen=True, slots=True)
class ComparisonRow:
    """One comparable, newly added, or removed function-case result."""

    status: str
    function: str
    format: str | None = None
    identifier: str | None = None
    baseline_median_ms: float | None = None
    candidate_median_ms: float | None = None

    def __post_init__(self) -> None:
        _string(self.function, "comparison function")
        if self.status == "comparable":
            if self.identifier is None or self.format is None:
                raise SchemaError("comparable rows require an id and format")
            _string(self.identifier, "comparison case id")
            _string(self.format, "comparison format")
            _number(self.baseline_median_ms, "baseline median", positive=True)
            _number(self.candidate_median_ms, "candidate median", positive=True)
            return
        if self.status not in {"added", "removed"}:
            raise SchemaError(f"unsupported comparison row status: {self.status}")
        if any(
            value is not None
            for value in (
                self.identifier,
                self.format,
                self.baseline_median_ms,
                self.candidate_median_ms,
            )
        ):
            raise SchemaError(f"{self.status} rows cannot contain timing data")

    def to_json(self) -> JsonObject:
        if self.status != "comparable":
            return {
                "id": None,
                "function": self.function,
                "format": None,
                "status": self.status,
                "baseline_median_ms": None,
                "candidate_median_ms": None,
                "delta_ms": None,
                "median_delta_ms": None,
                "delta_pct": None,
                "ratio": None,
                "na": f"{self.status} function",
            }
        assert self.baseline_median_ms is not None
        assert self.candidate_median_ms is not None
        ratio = self.candidate_median_ms / self.baseline_median_ms
        delta = self.candidate_median_ms - self.baseline_median_ms
        return {
            "id": self.identifier,
            "function": self.function,
            "format": self.format,
            "status": self.status,
            "baseline_median_ms": self.baseline_median_ms,
            "candidate_median_ms": self.candidate_median_ms,
            "delta_ms": delta,
            "median_delta_ms": delta,
            "delta_pct": (ratio - 1.0) * 100.0,
            "ratio": ratio,
        }

    @property
    def ratio(self) -> float | None:
        if self.status != "comparable":
            return None
        assert self.baseline_median_ms is not None
        assert self.candidate_median_ms is not None
        return self.candidate_median_ms / self.baseline_median_ms


@dataclass(frozen=True, slots=True)
class ComparisonSummary:
    """Aggregate statistics for a comparison report."""

    comparable_cases: int
    added_functions: int
    removed_functions: int
    geometric_ratio: float | None

    def __post_init__(self) -> None:
        for name, value in (
            ("comparable_cases", self.comparable_cases),
            ("added_functions", self.added_functions),
            ("removed_functions", self.removed_functions),
        ):
            _integer(value, name)
        if self.comparable_cases == 0 and self.geometric_ratio is not None:
            raise SchemaError("empty comparisons cannot have a geometric ratio")
        if self.comparable_cases > 0:
            _number(self.geometric_ratio, "geometric ratio", positive=True)

    def to_json(self) -> JsonObject:
        return {
            "comparable_cases": self.comparable_cases,
            "added_functions": self.added_functions,
            "removed_functions": self.removed_functions,
            "geometric_ratio": self.geometric_ratio,
            "ratio_definition": "candidate_median_ms / baseline_median_ms; lower is faster",
        }


__all__ = [
    "BenchmarkCase",
    "BenchmarkPlan",
    "BenchmarkResult",
    "CATALOG_VERSION",
    "CaseInput",
    "CaseResult",
    "ComparisonRow",
    "ComparisonSummary",
    "INPUT_VERSION",
    "JsonObject",
    "JsonValue",
    "SCHEMA_VERSION",
    "SampleStatistics",
    "SchemaError",
    "canonical_json",
]
