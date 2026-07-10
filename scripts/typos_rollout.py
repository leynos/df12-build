"""Refresh and render shared en-GB-oxendict ``typos`` configuration."""

from __future__ import annotations

import dataclasses
import email.utils
import json
import pathlib
import tomllib
import typing as typ
import urllib.error
import urllib.parse
import urllib.request

import typos_rollout_cache

if typ.TYPE_CHECKING:
    import collections.abc as cabc

RefreshResult = typos_rollout_cache.RefreshResult
_CacheTargets = typos_rollout_cache.CacheTargets
_RemoteResponse = typos_rollout_cache.RemoteResponse
_atomic_write = typos_rollout_cache.atomic_write

SCHEMA_VERSION = 1
HTTP_NOT_MODIFIED = 304
SUFFIX_PAIRS = (
    ("ise", "ize"),
    ("ises", "izes"),
    ("ised", "ized"),
    ("ising", "izing"),
    ("iser", "izer"),
    ("isers", "izers"),
    ("isable", "izable"),
    ("isation", "ization"),
    ("isations", "izations"),
)


@dataclasses.dataclass(frozen=True)
class Dictionary:
    """Curated words and exclusions used to generate a ``typos`` config."""

    stems: tuple[str, ...] = ()
    accepted: tuple[str, ...] = ()
    corrections: tuple[tuple[str, str], ...] = ()
    ignore_patterns: tuple[str, ...] = ()
    excluded_files: tuple[str, ...] = ()


def _string_list(table: cabc.Mapping[str, object], key: str) -> tuple[str, ...]:
    """Read and validate a list of strings from a TOML table."""
    value = table.get(key, [])
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        message = f"{key!r} must be a list of strings"
        raise TypeError(message)
    return tuple(sorted(set(value)))


def _table(document: cabc.Mapping[str, object], key: str) -> cabc.Mapping[str, object]:
    """Read and validate a TOML table."""
    value = document.get(key, {})
    if not isinstance(value, dict):
        message = f"{key!r} must be a table"
        raise TypeError(message)
    return value


def _dictionary_from_text(text: str) -> Dictionary:
    """Parse and validate shared dictionary text."""
    document = tomllib.loads(text)
    schema = document.get("schema")
    if schema != SCHEMA_VERSION:
        message = f"unsupported dictionary schema {schema!r}"
        raise ValueError(message)
    oxford = _table(document, "oxford")
    words = _table(document, "words")
    patterns = _table(document, "patterns")
    files = _table(document, "files")
    corrections_table = _table(words, "corrections")
    if not all(
        isinstance(key, str) and isinstance(value, str)
        for key, value in corrections_table.items()
    ):
        message = "word corrections must map strings to strings"
        raise TypeError(message)
    return Dictionary(
        stems=_string_list(oxford, "stems"),
        accepted=_string_list(words, "accepted"),
        corrections=tuple(sorted(corrections_table.items())),
        ignore_patterns=_string_list(patterns, "ignore"),
        excluded_files=_string_list(files, "exclude"),
    )


def load_dictionary(path: pathlib.Path) -> Dictionary:
    """Load a validated shared dictionary from *path*."""
    return _dictionary_from_text(path.read_text(encoding="utf-8"))


def merge_dictionaries(base: Dictionary, local: Dictionary) -> Dictionary:
    """Merge a shared dictionary with a non-conflicting local overlay."""
    corrections = dict(base.corrections)
    for word, correction in local.corrections:
        existing = corrections.get(word)
        if existing is not None and existing != correction:
            message = (
                f"conflicting correction for {word!r}: {existing!r} != {correction!r}"
            )
            raise ValueError(message)
        corrections[word] = correction
    return Dictionary(
        stems=tuple(sorted(set(base.stems) | set(local.stems))),
        accepted=tuple(sorted(set(base.accepted) | set(local.accepted))),
        corrections=tuple(sorted(corrections.items())),
        ignore_patterns=tuple(
            sorted(set(base.ignore_patterns) | set(local.ignore_patterns))
        ),
        excluded_files=tuple(
            sorted(set(base.excluded_files) | set(local.excluded_files))
        ),
    )


def generate_word_mappings(dictionary: Dictionary) -> dict[str, str]:
    """Expand Oxford stems and explicit words into deterministic mappings."""
    mappings = {word: word for word in dictionary.accepted}

    def add(word: str, correction: str) -> None:
        existing = mappings.get(word)
        if existing is not None and existing != correction:
            message = (
                f"conflicting generated correction for {word!r}: "
                f"{existing!r} != {correction!r}"
            )
            raise ValueError(message)
        mappings[word] = correction

    for word, correction in dictionary.corrections:
        add(word, correction)
    for stem in dictionary.stems:
        for plain_british, oxford in SUFFIX_PAIRS:
            add(f"{stem}{plain_british}", f"{stem}{oxford}")
            add(f"{stem}{oxford}", f"{stem}{oxford}")
    return dict(sorted(mappings.items()))


def _toml_string(value: str) -> str:
    """Render a string using TOML-compatible JSON quoting."""
    return json.dumps(value, ensure_ascii=False)


def _render_array(name: str, values: tuple[str, ...]) -> list[str]:
    """Render a deterministic TOML string array."""
    lines = [f"{name} = ["]
    lines.extend(f"    {_toml_string(value)}," for value in values)
    lines.append("]")
    return lines


def render_typos_config(dictionary: Dictionary) -> str:
    """Render a deterministic, parse-checked ``typos.toml`` document."""
    lines = [
        "# Generated from the shared en-GB-oxendict dictionary.",
        "# Regenerate with scripts/generate_typos_config.py; do not edit by hand.",
        "",
        "[files]",
        *_render_array("extend-exclude", dictionary.excluded_files),
        "",
        "[default]",
        'locale = "en-gb"',
        *_render_array("extend-ignore-re", dictionary.ignore_patterns),
        "",
        "[default.extend-words]",
    ]
    lines.extend(
        f"{_toml_string(word)} = {_toml_string(correction)}"
        for word, correction in generate_word_mappings(dictionary).items()
    )
    rendered = "\n".join(lines) + "\n"
    tomllib.loads(rendered)
    return rendered


def write_config(path: pathlib.Path, dictionary: Dictionary) -> None:
    """Atomically write validated generated configuration to *path*."""
    _atomic_write(path, render_typos_config(dictionary).encode())


def _read_metadata(path: pathlib.Path) -> dict[str, object]:
    """Read best-effort HTTP freshness metadata."""
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _write_metadata(
    path: pathlib.Path,
    metadata: cabc.Mapping[str, object],
) -> None:
    """Atomically write HTTP freshness metadata."""
    _atomic_write(path, (json.dumps(metadata, sort_keys=True) + "\n").encode())


def _valid_cache(cache: pathlib.Path) -> bool:
    """Return whether *cache* contains a valid shared dictionary."""
    try:
        load_dictionary(cache)
    except (
        FileNotFoundError,
        OSError,
        TypeError,
        ValueError,
        tomllib.TOMLDecodeError,
    ):
        return False
    return True


def _remote_is_not_newer(
    saved: cabc.Mapping[str, object],
    headers: cabc.Mapping[str, str],
) -> bool:
    """Return whether HTTP validators prove the response is not newer."""
    etag = headers.get("ETag")
    if etag is not None and etag == saved.get("etag"):
        return True
    modified = headers.get("Last-Modified")
    saved_modified = saved.get("last_modified")
    if not isinstance(modified, str) or not isinstance(saved_modified, str):
        return False
    try:
        return email.utils.parsedate_to_datetime(
            modified
        ) <= email.utils.parsedate_to_datetime(saved_modified)
    except (TypeError, ValueError):
        return modified == saved_modified


def _local_cache_is_current(
    cache: pathlib.Path,
    saved: cabc.Mapping[str, object],
    source_name: str,
    source_mtime_ns: int,
) -> bool:
    """Return whether metadata proves a valid local-source cache is current."""
    saved_mtime = saved.get("mtime_ns")
    has_matching_source = saved.get("source") == source_name
    has_new_enough_mtime = (
        isinstance(saved_mtime, int) and source_mtime_ns <= saved_mtime
    )
    return _valid_cache(cache) and has_matching_source and has_new_enough_mtime


def _refresh_local(
    source: pathlib.Path,
    cache: pathlib.Path,
    metadata: pathlib.Path,
) -> RefreshResult:
    """Refresh from a local authoritative copy when it is newer."""
    source_stat = source.stat()
    source_name = str(source.resolve())
    saved = _read_metadata(metadata)
    if _local_cache_is_current(
        cache,
        saved,
        source_name,
        source_stat.st_mtime_ns,
    ):
        return RefreshResult("current", cache)
    content = source.read_bytes()
    _dictionary_from_text(content.decode())
    _atomic_write(cache, content)
    _write_metadata(
        metadata,
        {"source": source_name, "mtime_ns": source_stat.st_mtime_ns},
    )
    return RefreshResult("refreshed", cache)


def _conditional_headers(saved: cabc.Mapping[str, object]) -> dict[str, str]:
    """Build conditional HTTP headers from persisted validators."""
    headers = {}
    if isinstance(saved.get("etag"), str):
        headers["If-None-Match"] = saved["etag"]
    if isinstance(saved.get("last_modified"), str):
        headers["If-Modified-Since"] = saved["last_modified"]
    return headers


def _https_request(
    source: str,
    headers: cabc.Mapping[str, str],
) -> urllib.request.Request:
    """Build a request after constraining the shared source to HTTPS."""
    if urllib.parse.urlsplit(source).scheme != "https":
        message = f"shared dictionary URL must use HTTPS: {source}"
        raise ValueError(message)
    return urllib.request.Request(source, headers=dict(headers))  # noqa: S310 - HTTPS is required above.


def _write_remote_cache(
    source: str,
    targets: _CacheTargets,
    content: bytes,
    headers: cabc.Mapping[str, str],
) -> RefreshResult:
    """Validate and atomically persist an HTTP dictionary response."""
    _dictionary_from_text(content.decode())
    _atomic_write(targets.cache, content)
    _write_metadata(
        targets.metadata,
        {
            "source": source,
            "etag": headers.get("ETag"),
            "last_modified": headers.get("Last-Modified"),
        },
    )
    return RefreshResult("refreshed", targets.cache)


def _remote_response_result(
    source: str,
    targets: _CacheTargets,
    saved: cabc.Mapping[str, object],
    response: _RemoteResponse,
) -> RefreshResult:
    """Return the cache result for a successful HTTP response."""
    if response.status == HTTP_NOT_MODIFIED and _valid_cache(targets.cache):
        return RefreshResult("current", targets.cache)
    if _valid_cache(targets.cache) and _remote_is_not_newer(saved, response.headers):
        return RefreshResult("current", targets.cache)
    return _write_remote_cache(source, targets, response.read(), response.headers)


def _stale_cache_or_raise(
    cache: pathlib.Path,
    error: OSError | urllib.error.URLError,
) -> RefreshResult:
    """Return a valid stale cache or propagate the download failure."""
    if _valid_cache(cache):
        return RefreshResult("stale-cache", cache)
    raise error


def _http_error_result(
    cache: pathlib.Path,
    error: urllib.error.HTTPError,
) -> RefreshResult:
    """Translate an HTTP failure into the available cache result."""
    if error.code == HTTP_NOT_MODIFIED and _valid_cache(cache):
        return RefreshResult("current", cache)
    return _stale_cache_or_raise(cache, error)


def _refresh_http(
    source: str,
    cache: pathlib.Path,
    metadata: pathlib.Path,
) -> RefreshResult:
    """Refresh a cache from a validated HTTPS source with stale fallback."""
    saved = _read_metadata(metadata)
    request = _https_request(source, _conditional_headers(saved))
    try:
        with urllib.request.urlopen(  # noqa: S310 - _https_request rejects non-HTTPS URLs.
            request,
            timeout=30.0,
        ) as response:
            return _remote_response_result(
                source, _CacheTargets(cache, metadata), saved, response
            )
    except urllib.error.HTTPError as error:
        return _http_error_result(cache, error)
    except (OSError, urllib.error.URLError) as error:
        return _stale_cache_or_raise(cache, error)


def refresh_base(
    source: str | pathlib.Path,
    cache: pathlib.Path,
    *,
    metadata: pathlib.Path,
    offline: bool = False,
) -> RefreshResult:
    """Refresh an untracked base cache when the authoritative copy is newer."""
    if offline:
        if not _valid_cache(cache):
            message = f"no cached shared dictionary at {cache}"
            raise FileNotFoundError(message)
        return RefreshResult("offline-cache", cache)
    if isinstance(source, pathlib.Path) or "://" not in str(source):
        return _refresh_local(pathlib.Path(source), cache, metadata)
    return _refresh_http(str(source), cache, metadata)
