"""Normalise double-encoded punctuation introduced by Windows PowerShell writes."""
import glob, os, sys

FIXES = {
    "\u00e2\u20ac\u201d": "\u2014",
    "\u00e2\u20ac\u201c": "\u2013",
    "\u00e2\u20ac\u2122": "\u2019",
    "\u00e2\u20ac\u0153": "\u201c",
    "\u00c2\u00b7": "\u00b7",
    "\u00c2\u00a7": "\u00a7",
    "\u00e2\u2020\u2019": "\u2192",
}

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
files = glob.glob(os.path.join(root, "docs", "*.md"))
files += [os.path.join(root, n) for n in ("README.md", "REQUIREMENTS.md", "ARCHITECTURE.md", "LICENSE", "AGENTS.md", "SECURITY.md", "CONTRIBUTING.md", "THIRD_PARTY_NOTICES.md")]
changed = 0
for path in files:
    if not os.path.exists(path):
        continue
    text = open(path, encoding="utf-8").read()
    fixed = text
    for bad, good in FIXES.items():
        fixed = fixed.replace(bad, good)
    if fixed != text:
        open(path, "w", encoding="utf-8", newline="\n").write(fixed)
        changed += 1
print(f"normalised {changed}/{len(files)} files")
