"""Provide cache support types and atomic writes for the spelling helper."""

from __future__ import annotations

import dataclasses
import pathlib
import tempfile
import typing as typ

if typ.TYPE_CHECKING:
    import collections.abc as cabc


@dataclasses.dataclass(frozen=True)
class RefreshResult:
    """Describe whether the untracked shared dictionary cache changed."""

    status: str
    cache: pathlib.Path


@dataclasses.dataclass(frozen=True)
class CacheTargets:
    """Group the untracked dictionary cache and metadata sidecar paths."""

    cache: pathlib.Path
    metadata: pathlib.Path


class RemoteResponse(typ.Protocol):
    """Expose the HTTP response surface used by cache refresh."""

    status: int
    headers: cabc.Mapping[str, str]

    def read(self) -> bytes:
        """Read the response body."""
        ...


def atomic_write(path: pathlib.Path, content: bytes) -> None:
    """Write content beside a path and atomically replace the destination."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        delete=False, dir=path.parent, prefix=f".{path.name}."
    ) as stream:
        stream.write(content)
        temporary = pathlib.Path(stream.name)
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
