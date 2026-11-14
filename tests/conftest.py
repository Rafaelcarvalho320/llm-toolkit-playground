import sys
from pathlib import Path

# The bridge is served to the browser as a plain file, not installed as a
# package, so the tests import it from where the page loads it.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "site" / "py"))
