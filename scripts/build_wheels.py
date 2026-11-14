"""Build the wheels the page loads into Pyodide, from the pinned requirements.

The libraries are pure Python with no dependencies, so a ``py3-none-any`` wheel
of each is all Pyodide needs. ``site/wheels/manifest.json`` lists them, which is
how the page knows the file names without hard-coding versions.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "site" / "wheels"


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.whl"):
        old.unlink()
    subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "wheel",
            "--quiet",
            "--no-deps",
            "-r",
            str(ROOT / "requirements.txt"),
            "-w",
            str(OUT),
        ],
        check=True,
    )
    wheels = sorted(path.name for path in OUT.glob("*.whl"))
    pinned = [
        line
        for line in (ROOT / "requirements.txt").read_text().splitlines()
        if line.strip() and not line.startswith("#")
    ]
    if len(wheels) != len(pinned):
        print(f"expected {len(pinned)} wheels, built {len(wheels)}: {wheels}", file=sys.stderr)
        return 1
    if not all(name.endswith("-py3-none-any.whl") for name in wheels):
        print(f"a wheel is not pure Python, Pyodide cannot load it: {wheels}", file=sys.stderr)
        return 1
    (OUT / "manifest.json").write_text(json.dumps({"wheels": wheels}, indent=2) + "\n")
    for name in wheels:
        print(name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
