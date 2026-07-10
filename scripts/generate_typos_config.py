#!/usr/bin/env -S uv run python
# /// script
# requires-python = ">=3.13"
# dependencies = []
# ///
"""Generate ``typos.toml`` from the shared en-GB-oxendict dictionary.

The shared dictionary is refreshed into an untracked repository-local cache
only when the authoritative copy is newer. A valid cache remains usable when
the network is unavailable, and ``typos.local.toml`` supplies the narrow
repository-specific policy that must not weaken the estate-wide base.
"""

import tomllib
import urllib.error
import urllib.parse
from pathlib import Path

import typos_rollout as rollout

DEFAULT_BASE_URL = (
    "https://raw.githubusercontent.com/leynos/agent-helper-scripts/"
    "refs/heads/main/data/typos-oxendict-base.toml"
)
REPOSITORY_ROOT = Path(__file__).resolve().parent.parent


def dictionary_from_cache(repository: Path = REPOSITORY_ROOT) -> rollout.Dictionary:
    """Load the cached shared base merged with local repository policy."""
    dictionary = rollout.load_dictionary(repository / ".typos-oxendict-base.toml")
    local_overlay = repository / "typos.local.toml"
    if local_overlay.exists():
        dictionary = rollout.merge_dictionaries(
            dictionary,
            rollout.load_dictionary(local_overlay),
        )
    return dictionary


def render_config(repository: Path = REPOSITORY_ROOT) -> str:
    """Render deterministic configuration from the populated local cache."""
    return rollout.render_typos_config(dictionary_from_cache(repository))


def _tracked_remote_fallback(
    source: str | Path,
    destination: Path,
) -> rollout.RefreshResult | None:
    """Return a valid tracked config only for an unavailable HTTPS authority."""
    if not isinstance(source, str) or urllib.parse.urlsplit(source).scheme != "https":
        return None
    try:
        tomllib.loads(destination.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, tomllib.TOMLDecodeError):
        return None
    return rollout.RefreshResult("tracked-config", destination)


def main(
    output: Path | None = None,
    *,
    repository: Path = REPOSITORY_ROOT,
    source: str | Path = DEFAULT_BASE_URL,
    offline: bool = False,
) -> rollout.RefreshResult:
    """Refresh the shared base cache and write the merged configuration."""
    destination = output if output is not None else repository / "typos.toml"
    try:
        result = rollout.refresh_base(
            source,
            repository / ".typos-oxendict-base.toml",
            metadata=repository / ".typos-oxendict-base.json",
            offline=offline,
        )
    except (OSError, urllib.error.URLError):
        fallback = _tracked_remote_fallback(source, destination)
        if fallback is not None:
            return fallback
        raise
    rollout.write_config(destination, dictionary_from_cache(repository))
    return result


if __name__ == "__main__":
    refresh = main()
    print(f"{refresh.status}: {REPOSITORY_ROOT / 'typos.toml'}")
