"""Regenerate the committed (pruned) Codex app-server schema.

Usage (from ``backend/``):

    uv run python ../scripts/verify/codex/update_schema.py [--codex /path/to/codex] [--bundle DIR]

Runs ``codex app-server generate-json-schema --experimental`` (no login, no network), prunes the
bundle to the methods listed in ``aistudio/adapters/codex/protocol.py`` and writes
``backend/src/aistudio/adapters/codex/schema/codex_app_server_protocol.subset.json``.
Afterwards run ``uv run pytest tests/adapters_codex`` - the drift test tells you which models
need updating. ``--check`` only reports differences and exits 1 when there are any.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from aistudio.adapters.codex import schema_tools


def generate_bundle(codex: str, out_dir: Path) -> tuple[dict, str]:
    version_out = subprocess.run([codex, "--version"], capture_output=True, text=True, check=True).stdout
    m = re.search(r"(\d+\.\d+\.\d+)", version_out)
    version = m.group(1) if m else version_out.strip()
    subprocess.run(
        [codex, "app-server", "generate-json-schema", "--experimental", "--out", str(out_dir)],
        check=True,
        capture_output=True,
    )
    return json.loads((out_dir / schema_tools.BUNDLE_FILE_NAME).read_text(encoding="utf-8")), version


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--codex", default="codex", help="codex binary (default: codex on PATH)")
    ap.add_argument("--bundle", type=Path, help="use an already generated schema directory instead of running codex")
    ap.add_argument("--version", help="codex version to record (required with --bundle)")
    ap.add_argument("--check", action="store_true", help="only compare with the committed schema")
    args = ap.parse_args()

    if args.bundle:
        bundle = json.loads((args.bundle / schema_tools.BUNDLE_FILE_NAME).read_text(encoding="utf-8"))
        version = args.version or "unknown"
    else:
        with tempfile.TemporaryDirectory() as tmp:
            bundle, version = generate_bundle(args.codex, Path(tmp))

    pruned = schema_tools.prune_bundle(bundle, codex_version=version)
    if args.check:
        diffs = schema_tools.compare_used(schema_tools.load_committed(), pruned)
        for d in diffs:
            print(d)
        print("OK: no drift" if not diffs else f"{len(diffs)} difference(s)")
        return 1 if diffs else 0

    schema_tools.SCHEMA_DIR.mkdir(parents=True, exist_ok=True)
    schema_tools.SCHEMA_FILE.write_text(schema_tools.dumps(pruned), encoding="utf-8")
    size = schema_tools.SCHEMA_FILE.stat().st_size
    print(f"wrote {schema_tools.SCHEMA_FILE} ({size // 1024} KiB, codex {version})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
