"""Copy the Pyodide runtime into ``site/pyodide/``, verified against a pinned hash.

Serving Pyodide from the page's own origin instead of a CDN means the page
runs no third-party code at all, which is what lets its Content Security Policy
forbid every other origin. The playground's privacy promise - nothing typed
leaves the browser - is then enforced by the browser rather than just stated:
a script that tried to send a pasted CPF anywhere would be blocked.

The tarball is the one npm publishes, checked against the ``integrity`` value
from the registry before anything is extracted, and only the files the page
needs are taken out of it, by exact name.
"""

from __future__ import annotations

import base64
import hashlib
import io
import sys
import tarfile
import urllib.request
from pathlib import Path

VERSION = "314.0.7"
TARBALL = f"https://registry.npmjs.org/pyodide/-/pyodide-{VERSION}.tgz"
#: ``dist.integrity`` from https://registry.npmjs.org/pyodide/314.0.7
INTEGRITY = "sha512-0YvXxEhfEdpLfb/XkM2BFAeMROq0iMUX2bzzH9pOttyMcWkwq+HbE5uyuGD82LN7y2q+SNvi/6V5JEsOlD2R1A=="  # noqa: E501
FILES = (
    "pyodide.mjs",
    "pyodide.asm.mjs",
    "pyodide.asm.wasm",
    "python_stdlib.zip",
    "pyodide-lock.json",
)

OUT = Path(__file__).resolve().parents[1] / "site" / "pyodide"


def main() -> int:
    with urllib.request.urlopen(TARBALL, timeout=120) as response:  # noqa: S310 - fixed https URL
        payload = response.read()

    algorithm, _, expected = INTEGRITY.partition("-")
    actual = base64.b64encode(hashlib.new(algorithm, payload).digest()).decode()
    if actual != expected:
        print(f"integrity mismatch for {TARBALL}: got {algorithm}-{actual}", file=sys.stderr)
        return 1

    OUT.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
        for name in FILES:
            member = archive.getmember(f"package/{name}")
            if not member.isfile():
                print(f"{name} is not a regular file in the tarball", file=sys.stderr)
                return 1
            source = archive.extractfile(member)
            assert source is not None
            (OUT / name).write_bytes(source.read())
            print(f"{name} ({member.size:,} bytes)")
    (OUT / "VERSION").write_text(VERSION + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
