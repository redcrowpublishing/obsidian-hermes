#!/usr/bin/env python3
"""Legacy-compatible vault search helper for Hermes Agent.

The plugin uses the JavaScript helper by default. This Python helper is kept only
for users who prefer a Python command-line search during debugging.
"""

from __future__ import annotations

import argparse
from pathlib import Path

MAX_OUTPUT_CHARS = 20_000
DEFAULT_CONTEXT = 8


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Search a text/Markdown file with line context.")
    parser.add_argument("--query", required=True, help="Literal search text")
    parser.add_argument("--path", required=True, help="File path to search")
    parser.add_argument("--context", type=int, default=DEFAULT_CONTEXT, help="Context lines around each match")
    parser.add_argument("--max-chars", type=int, default=MAX_OUTPUT_CHARS, help="Maximum output characters")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    path = Path(args.path).expanduser()
    if not path.is_file():
        raise SystemExit(f"Not a file: {path}")
    query = args.query.casefold()
    if not query:
        raise SystemExit("Empty query")
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    hits = [idx for idx, line in enumerate(lines) if query in line.casefold()]
    if not hits:
        print("No matches found.")
        return 0
    parts: list[str] = [f"Search: {args.query!r} in {path}\n"]
    emitted: set[int] = set()
    for hit in hits:
        start = max(0, hit - max(0, args.context))
        end = min(len(lines), hit + max(0, args.context) + 1)
        if any(i in emitted for i in range(start, end)):
            continue
        parts.append(f"\n--- lines {start + 1}-{end} ---")
        for i in range(start, end):
            emitted.add(i)
            marker = ">" if i == hit else " "
            parts.append(f"{marker} {i + 1}: {lines[i]}")
        if sum(len(p) + 1 for p in parts) > args.max_chars:
            parts.append("\n[truncated]")
            break
    print("\n".join(parts)[: args.max_chars])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
