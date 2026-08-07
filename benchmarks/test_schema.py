"""Contract tests for the benchmark JSON boundary.

These tests intentionally do not import VapourSynth.  They verify that plans
and results remain portable across the detached build and measurement phases.
"""

from __future__ import annotations

import unittest

from benchmarks.benchmark import BenchmarkError, Timing, _validate_result, build_parser, compare_cases

from benchmarks.catalog import build_plan
from benchmarks.schema import BenchmarkPlan, BenchmarkResult, CaseResult, SchemaError


def _result_for(plan: BenchmarkPlan, /, *, median_ms: float = 2.0) -> BenchmarkResult:
    return BenchmarkResult(
        plan_id=plan.identifier,
        timing="direct",
        config={"iterations": 3, "warmup": 1},
        environment={"id": "unit-test"},
        cases=tuple(
            CaseResult.from_json(
                {
                    "id": case.identifier,
                    "samples_ms": [1.0, median_ms, 3.0],
                    "mean_ms": (1.0 + median_ms + 3.0) / 3.0,
                    "median_ms": median_ms,
                    "min_ms": 1.0,
                    "max_ms": 3.0,
                    "median_fps": 1_000.0 / median_ms,
                }
            )
            for case in plan.cases
        ),
    )


class BenchmarkSchemaTests(unittest.TestCase):
    def test_quick_cli_defaults_to_fast_local_run(self) -> None:
        arguments = build_parser().parse_args(["quick"])

        self.assertEqual(arguments.command, "quick")
        self.assertEqual(arguments.functions, [])
        self.assertEqual(arguments.formats, [])
        self.assertEqual(arguments.iterations, 3)
        self.assertEqual(arguments.warmup, 0)
        self.assertEqual(arguments.timing, "direct")
        self.assertFalse(arguments.no_build)

    def test_plan_round_trip_preserves_stable_identifiers(self) -> None:
        plan = build_plan(functions=["IQM"], formats=["u8"], width=80, height=48)

        restored = BenchmarkPlan.from_json(plan.to_json())

        self.assertEqual(restored, plan)
        self.assertEqual([case.function for case in restored.cases], ["InterQuartileMean"] * 3)

    def test_plan_rejects_a_tampered_case_id(self) -> None:
        payload = build_plan(functions=["Median"], formats=["u8"]).to_json()
        cases = payload["cases"]
        assert isinstance(cases, list)
        case = cases[0]
        assert isinstance(case, dict)
        case["id"] = "not-a-content-addressed-id"

        with self.assertRaises(SchemaError):
            BenchmarkPlan.from_json(payload)

    def test_result_must_cover_exactly_the_plan_cases(self) -> None:
        plan = build_plan(functions=["Median"], formats=["u8"])
        payload = _result_for(plan).to_json()
        cases = payload["cases"]
        assert isinstance(cases, list)
        cases.pop()

        with self.assertRaises(BenchmarkError):
            _validate_result(payload, plan, Timing("direct", 3, 1))

    def test_comparison_uses_median_ratio(self) -> None:
        plan = build_plan(functions=["Median"], formats=["u8"])
        baseline = _result_for(plan, median_ms=2.0)
        candidate = _result_for(plan, median_ms=1.0)

        rows, summary = compare_cases(plan, baseline, candidate, [], [])

        self.assertEqual(len(rows), len(plan.cases))
        self.assertEqual(summary.geometric_ratio, 0.5)
        self.assertTrue(all(row.status == "comparable" for row in rows))


if __name__ == "__main__":
    unittest.main()
