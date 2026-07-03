#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "cyclopts>=3.0",
# ]
# ///

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any

from cyclopts import App, Parameter


app = App(help="Tabulate ODW runs from ~/.odw/runs.")


@dataclass(frozen=True)
class RunRow:
    source: str
    status: str
    updated_at: float | str | None
    run_id: str
    workflow_name: str


def read_json(path: Path) -> dict[str, Any]:
    try:
        with path.open(encoding="utf-8") as handle:
            data = json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}

    if isinstance(data, dict):
        return data
    return {}


def coerce_timestamp(value: Any) -> float | str | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return value
    return str(value)


def display_timestamp(value: float | str | None) -> str:
    if value is None:
        return ""
    if isinstance(value, float):
        return datetime.fromtimestamp(value, tz=UTC).isoformat(timespec="seconds").replace(
            "+00:00", "Z"
        )
    return value


def sort_key(row: RunRow) -> tuple[int, float | str]:
    if isinstance(row.updated_at, float):
        return (1, row.updated_at)
    if isinstance(row.updated_at, str):
        return (0, row.updated_at)
    return (0, "")


def collect_runs(runs_dir: Path) -> list[RunRow]:
    rows: list[RunRow] = []

    for run_dir in sorted(path for path in runs_dir.glob("*/*") if path.is_dir()):
        status_data = read_json(run_dir / "status.json")
        meta_data = read_json(run_dir / "meta.json")

        status = str(
            status_data.get("state")
            or status_data.get("status")
            or meta_data.get("status")
            or ""
        )
        updated_at = coerce_timestamp(
            status_data.get("updatedAt")
            or status_data.get("updated_at")
            or meta_data.get("updatedAt")
            or meta_data.get("createdAt")
            or meta_data.get("created_at")
        )
        run_id = str(status_data.get("runId") or meta_data.get("runId") or run_dir.name)
        workflow_name = str(
            meta_data.get("workflowName")
            or status_data.get("name")
            or meta_data.get("name")
            or run_dir.parent.name
        )
        source = str(meta_data.get("source") or "")

        rows.append(
            RunRow(
                source=source,
                status=status,
                updated_at=updated_at,
                run_id=run_id,
                workflow_name=workflow_name,
            )
        )

    return rows


def filter_rows(
    rows: list[RunRow],
    *,
    show_all: bool,
    statuses: list[str] | None,
    source: str | None,
    workflow: str | None,
) -> list[RunRow]:
    status_filter = {status.casefold() for status in statuses or []}
    if not show_all and not status_filter:
        status_filter = {"running"}

    filtered = rows
    if status_filter:
        filtered = [row for row in filtered if row.status.casefold() in status_filter]
    if source:
        source_query = source.casefold()
        filtered = [row for row in filtered if source_query in row.source.casefold()]
    if workflow:
        workflow_query = workflow.casefold()
        filtered = [
            row for row in filtered if workflow_query in row.workflow_name.casefold()
        ]

    return sorted(filtered, key=sort_key, reverse=True)


def table(rows: list[RunRow]) -> str:
    headers = ["source", "status", "updatedat", "run id", "workflow name"]
    body = [
        [
            row.source,
            row.status,
            display_timestamp(row.updated_at),
            row.run_id,
            row.workflow_name,
        ]
        for row in rows
    ]

    widths = [
        max(len(str(row[column])) for row in [headers, *body])
        for column in range(len(headers))
    ]

    def render(row: list[str]) -> str:
        return "  ".join(value.ljust(width) for value, width in zip(row, widths))

    lines = [render(headers), render(["-" * width for width in widths])]
    lines.extend(render(row) for row in body)
    return "\n".join(lines)


@app.default
def main(
    *,
    runs_dir: Annotated[
        Path,
        Parameter(help="Root ODW runs directory."),
    ] = Path.home() / ".odw" / "runs",
    show_all: Annotated[
        bool,
        Parameter(name="--all", negative=False, help="Show all run statuses."),
    ] = False,
    statuses: Annotated[
        list[str] | None,
        Parameter(name=("--status", "-s"), help="Status to show. Repeatable."),
    ] = None,
    source: Annotated[
        str | None,
        Parameter(help="Case-insensitive substring filter for source."),
    ] = None,
    workflow: Annotated[
        str | None,
        Parameter(help="Case-insensitive substring filter for workflow name."),
    ] = None,
    limit: Annotated[
        int | None,
        Parameter(help="Maximum number of rows to print."),
    ] = None,
) -> None:
    """Show ODW run status rows, defaulting to running runs."""
    rows = filter_rows(
        collect_runs(runs_dir),
        show_all=show_all,
        statuses=statuses,
        source=source,
        workflow=workflow,
    )
    if limit is not None:
        rows = rows[:limit]

    print(table(rows))


if __name__ == "__main__":
    app()
