#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "cyclopts>=3.0",
# ]
# ///
"""Behavioural tests for the ODW operator scripts.

Loads ``scripts/list-odw-runs.py`` and ``scripts/odw-watch`` (hyphenated and
extensionless, hence the explicit source loaders) and exercises their pure
helpers and filesystem behaviour against throwaway fixtures: JSON tolerance
and warnings, filtering and sorting, exact table and event rendering, torn
event lines, and the offset hand-off that keeps the watcher from skipping
events appended between its initial read and the first poll.

Run directly or through the repository gate::

    uv run tests/run-odw-script-tests.py
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from collections.abc import Mapping
from importlib.machinery import SourceFileLoader
from pathlib import Path
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"


def load_script(module_name: str, filename: str):
    """Import a script that is not a conventionally named module."""
    loader = SourceFileLoader(module_name, str(SCRIPTS_DIR / filename))
    spec = importlib.util.spec_from_loader(module_name, loader)
    module = importlib.util.module_from_spec(spec)
    # Register before executing: dataclasses resolve string annotations (from
    # `from __future__ import annotations`) through sys.modules.
    sys.modules[module_name] = module
    loader.exec_module(module)
    return module


list_runs = load_script("list_odw_runs", "list-odw-runs.py")
odw_watch = load_script("odw_watch", "odw-watch")


def make_run_dir(
    root: Path,
    workflow: str,
    run_id: str,
    *,
    status: Mapping[str, Any],
    meta: Mapping[str, Any],
) -> Path:
    run_dir = root / workflow / run_id
    run_dir.mkdir(parents=True)
    (run_dir / "status.json").write_text(json.dumps(status), encoding="utf-8")
    (run_dir / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    return run_dir


class ReadJsonTests(unittest.TestCase):
    def test_missing_file_is_silent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                self.assertEqual(list_runs.read_json(Path(tmp) / "absent.json"), {})
            self.assertEqual(stderr.getvalue(), "")

    def test_malformed_file_warns_and_returns_empty(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            broken = Path(tmp) / "broken.json"
            broken.write_text('{"torn": ', encoding="utf-8")
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                self.assertEqual(list_runs.read_json(broken), {})
            self.assertIn("warning: skipping unreadable", stderr.getvalue())

    def test_non_object_payload_returns_empty(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            listy = Path(tmp) / "list.json"
            listy.write_text("[1, 2]", encoding="utf-8")
            self.assertEqual(list_runs.read_json(listy), {})


class TimestampTests(unittest.TestCase):
    def test_coerce_timestamp(self) -> None:
        self.assertIsNone(list_runs.coerce_timestamp(None))
        self.assertEqual(list_runs.coerce_timestamp(5), 5.0)
        self.assertEqual(list_runs.coerce_timestamp("5.5"), 5.5)
        self.assertEqual(list_runs.coerce_timestamp("yesterday"), "yesterday")
        self.assertEqual(list_runs.coerce_timestamp({"odd": 1}), "{'odd': 1}")

    def test_display_timestamp(self) -> None:
        self.assertEqual(list_runs.display_timestamp(None), "")
        self.assertEqual(list_runs.display_timestamp(0.0), "1970-01-01T00:00:00Z")
        self.assertEqual(list_runs.display_timestamp("raw"), "raw")


class FilterAndTableTests(unittest.TestCase):
    def rows(self) -> list[Any]:
        make = list_runs.RunRow
        return [
            make(source="/p/a", status="running", updated_at=200.0, run_id="r1", workflow_name="build"),
            make(source="/p/b", status="done", updated_at=300.0, run_id="r2", workflow_name="build"),
            make(source="/p/a", status="running", updated_at=100.0, run_id="r3", workflow_name="research"),
            make(source="/p/c", status="failed", updated_at="broken", run_id="r4", workflow_name="build"),
        ]

    def test_default_filter_keeps_running_only_newest_first(self) -> None:
        rows = list_runs.filter_rows(self.rows(), show_all=False, statuses=None, source=None, workflow=None)
        self.assertEqual([row.run_id for row in rows], ["r1", "r3"])

    def test_show_all_and_status_filters(self) -> None:
        rows = list_runs.filter_rows(self.rows(), show_all=True, statuses=None, source=None, workflow=None)
        self.assertEqual([row.run_id for row in rows], ["r2", "r1", "r3", "r4"])
        rows = list_runs.filter_rows(self.rows(), show_all=False, statuses=["DONE"], source=None, workflow=None)
        self.assertEqual([row.run_id for row in rows], ["r2"])

    def test_source_and_workflow_substring_filters(self) -> None:
        rows = list_runs.filter_rows(self.rows(), show_all=True, statuses=None, source="/p/a", workflow=None)
        self.assertEqual([row.run_id for row in rows], ["r1", "r3"])
        rows = list_runs.filter_rows(self.rows(), show_all=True, statuses=None, source=None, workflow="RESEARCH")
        self.assertEqual([row.run_id for row in rows], ["r3"])

    def test_collect_runs_reads_status_and_meta(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            make_run_dir(
                root,
                "build",
                "run-1",
                status={"state": "running", "updatedAt": 200},
                meta={"runId": "run-1", "workflowName": "build", "source": "/p/a"},
            )
            rows = list_runs.collect_runs(root)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].status, "running")
        self.assertEqual(rows[0].updated_at, 200.0)
        self.assertEqual(rows[0].workflow_name, "build")

    def test_table_snapshot(self) -> None:
        rows = [
            list_runs.RunRow(source="/p/a", status="running", updated_at=0.0, run_id="r1", workflow_name="build"),
            list_runs.RunRow(source="/p/bb", status="done", updated_at=None, run_id="r2", workflow_name="w"),
        ]
        expected = "\n".join(
            [
                "source  status   updatedat             run id  workflow name",
                "------  -------  --------------------  ------  -------------",
                "/p/a    running  1970-01-01T00:00:00Z  r1      build        ",
                "/p/bb   done                           r2      w            ",
            ]
        )
        self.assertEqual(list_runs.table(rows), expected)


class EventParsingTests(unittest.TestCase):
    def run_fixture(self, tmp: Path) -> object:
        run_dir = tmp / "wf" / "run1"
        run_dir.mkdir(parents=True)
        return odw_watch.Run(path=run_dir, run_id="run1", source=str(tmp / "src"))

    def test_parse_event_variants(self) -> None:
        run = odw_watch.Run(path=Path("/nowhere"), run_id="x", source="/s")
        good = odw_watch.parse_event(b'{"ts": 5, "type": "log"}\n', sequence=1, run=run)
        self.assertEqual((good.ts, good.sequence), (5.0, 1))
        self.assertIsNone(odw_watch.parse_event(b"\xff\xfe\n", sequence=0, run=run))
        self.assertIsNone(odw_watch.parse_event(b"[1]\n", sequence=0, run=run))
        self.assertEqual(odw_watch.parse_event(b'{"type": "log"}\n', sequence=0, run=run).ts, 0.0)

    def test_read_events_leaves_torn_line_for_the_next_poll(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            run = self.run_fixture(Path(tmp))
            run.events_path.write_bytes(b'{"ts": 1, "type": "log", "message": "a"}\n{"ts": 2, "ty')
            events, offset = odw_watch.read_events(run)
            self.assertEqual([event.data["message"] for event in events], ["a"])

            with run.events_path.open("ab") as handle:
                handle.write(b'pe": "log", "message": "b"}\n')
            resumed, _ = odw_watch.read_events(run, start_offset=offset)
            self.assertEqual([event.data["message"] for event in resumed], ["b"])

    def test_undecodable_complete_line_warns_and_is_skipped(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            run = self.run_fixture(Path(tmp))
            run.events_path.write_bytes(b'not json\n{"ts": 2, "type": "log", "message": "ok"}\n')
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                events, _ = odw_watch.read_events(run)
            self.assertEqual([event.data["message"] for event in events], ["ok"])
            self.assertIn("undecodable event line", stderr.getvalue())

    def test_recent_events_seeds_offsets_for_the_startup_poll_gap(self) -> None:
        # Regression for the discovery-to-first-poll interleaving: an event
        # appended after the initial read must be picked up exactly once by
        # resuming from the returned offsets, never skipped by re-statting.
        with tempfile.TemporaryDirectory() as tmp:
            run = self.run_fixture(Path(tmp))
            run.events_path.write_bytes(
                b'{"ts": 1, "type": "log", "message": "old-1"}\n{"ts": 2, "type": "log", "message": "old-2"}\n'
            )
            recent, offsets = odw_watch.recent_events([run], 1)
            self.assertEqual([event.data["message"] for event in recent], ["old-2"])

            with run.events_path.open("ab") as handle:
                handle.write(b'{"ts": 3, "type": "log", "message": "appended"}\n')
            events, _ = odw_watch.read_events(run, start_offset=offsets[run.path])
            self.assertEqual([event.data["message"] for event in events], ["appended"])

    def test_read_events_bounded_buffer_keeps_the_tail_and_the_offset(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            run = self.run_fixture(Path(tmp))
            payload = b"".join(
                json.dumps({"ts": index, "type": "log", "message": f"m{index}"}).encode() + b"\n"
                for index in range(1, 6)
            )
            run.events_path.write_bytes(payload)
            events, offset = odw_watch.read_events(run, max_events=2)
            self.assertEqual([event.data["message"] for event in events], ["m4", "m5"])
            self.assertEqual(offset, len(payload), "the offset must reflect the full scan, not the buffer")

    def test_recent_events_zero_limit_still_returns_offsets(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            run = self.run_fixture(Path(tmp))
            payload = b'{"ts": 1, "type": "log", "message": "a"}\n'
            run.events_path.write_bytes(payload)
            recent, offsets = odw_watch.recent_events([run], 0)
            self.assertEqual(recent, [])
            self.assertEqual(offsets[run.path], len(payload))


class LimitValidationTests(unittest.TestCase):
    def test_negative_limit_is_rejected(self) -> None:
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit) as caught:
            list_runs.main(limit=-1)
        self.assertEqual(caught.exception.code, 2)
        self.assertIn("--limit must be non-negative", stderr.getvalue())


class OffsetPruningTests(unittest.TestCase):
    def test_prunes_only_deleted_run_directories(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            alive = Path(tmp) / "alive"
            alive.mkdir()
            deleted = Path(tmp) / "deleted"
            offsets = {alive: 10, deleted: 20}
            odw_watch.prune_dead_offsets(offsets)
        self.assertEqual(offsets, {alive: 10})


class EventRenderingTests(unittest.TestCase):
    def test_event_detail_snapshots(self) -> None:
        cases = [
            ({"type": "log", "message": "hello"}, "hello"),
            ({"type": "phase_started", "phase": "Plan"}, "(Plan) phase started"),
            (
                {"type": "agent_started", "phase": "Plan", "label": "plan:1.2.3"},
                "(Plan) plan:1.2.3 r1",
            ),
            (
                {"type": "agent_finished", "phase": "Plan", "label": "plan:1.2.3", "attempts": 2},
                "(Plan) plan:1.2.3 r2",
            ),
            ({"type": "run_started", "runId": "r1"}, "(run) run: r1"),
            ({"type": "run_failed", "runId": "r1", "error": "boom"}, "(run) run: r1 failed: boom"),
            ({"type": "mystery", "ts": 1, "extra": 2}, '{"extra": 2}'),
        ]
        for payload, expected in cases:
            with self.subTest(payload=payload):
                self.assertEqual(odw_watch.event_detail(payload), expected)


class DiscoveryTests(unittest.TestCase):
    def test_discover_running_runs_matches_source_and_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "project"
            source.mkdir()
            make_run_dir(
                root / "runs",
                "build",
                "running-match",
                status={"state": "running"},
                meta={"runId": "running-match", "source": str(source)},
            )
            make_run_dir(
                root / "runs",
                "build",
                "done-match",
                status={"state": "done"},
                meta={"runId": "done-match", "source": str(source)},
            )
            make_run_dir(
                root / "runs",
                "build",
                "running-other",
                status={"state": "running"},
                meta={"runId": "running-other", "source": str(root / "other")},
            )
            runs = odw_watch.discover_running_runs(root / "runs", source)
        self.assertEqual([run.run_id for run in runs], ["running-match"])


if __name__ == "__main__":
    unittest.main()
