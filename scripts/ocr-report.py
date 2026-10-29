"""Compare OCR output against the exact ground truth and write the report."""
import json, os, re, difflib

here = os.path.dirname(os.path.abspath(__file__))
docs = os.path.abspath(os.path.join(here, "..", "docs"))
truth = json.load(open(os.path.join(docs, "ocr-fixtures", "ground-truth.json"), encoding="utf-8"))
results = json.load(open(os.path.join(docs, "ocr-results.json"), encoding="utf-8"))


def norm(text):
    return re.sub(r"\s+", " ", text.lower()).strip()


rows = []
for item in results["results"]:
    expected = norm(truth[item["file"]])
    actual = norm(item["text"])
    ratio = difflib.SequenceMatcher(None, expected, actual).ratio()
    expected_words = expected.split()
    actual_words = actual.split()
    # Levenshtein at word level for an intuitive error rate.
    matcher = difflib.SequenceMatcher(None, expected_words, actual_words)
    matches = sum(block.size for block in matcher.get_matching_blocks())
    wer = 1 - (matches / max(1, len(expected_words)))
    rows.append(
        {
            "file": item["file"],
            "ms": item["ms"],
            "confidence": item["confidence"],
            "char_accuracy": round(ratio * 100, 1),
            "word_error_rate": round(wer * 100, 1),
            "rss_delta_mb": item["rssDeltaMB"],
            "chars": len(actual),
        }
    )

md = [
    "# OCR evaluation — Tesseract.js",
    "",
    f"Engine: `{results['engine']}` {results['version']} · languages: {', '.join(results['languages'])} · "
    f"Node {results['node']} on {results['platform']}.",
    "",
    f"> {results['note']}",
    "",
    "| Fixture | Time | Confidence | Char accuracy | Word error rate | RSS delta |",
    "|---|---|---|---|---|---|",
]
for row in rows:
    md.append(
        f"| `{row['file']}` | {row['ms']} ms | {row['confidence']} | {row['char_accuracy']}% | "
        f"{row['word_error_rate']}% | {row['rss_delta_mb']} MB |"
    )
md += [
    "",
    "## Fixtures",
    "",
    "- `clean.png` — 1700×2200, 34 px serif, high contrast. Represents a well-produced digital-to-scan export.",
    "- `lowcontrast_skew.png` — grey text, 1.4° rotation, Gaussian blur and JPEG compression.",
    "- `dense_columns.png` — 22 px two-column layout, 104 lines. Tests reading-order handling.",
    "",
    "Ground truth is exact by construction (`docs/ocr-fixtures/ground-truth.json`), so accuracy is measured, not estimated.",
    "",
    "## Interpretation",
    "",
    "- Tesseract.js is usable for clean print, but two-column reading order is a known weakness: it concatenates by line, "
    "so a column-aware post-pass is required before chunking pages.",
    "- On a phone the same WASM worker will be slower and heavier than in Node; the numbers above are a lower bound for "
    "time and a rough signal for memory, not a mobile benchmark.",
    "- Licence: Tesseract.js and the `eng` traineddata are Apache-2.0. ML Kit (the native alternative) is free to use "
    "but its SDK terms are proprietary and it requires a development build.",
    "",
    "## Decision",
    "",
    "Ship the `OcrEngine` adapter with **no engine enabled by default**. On-device OCR stays opt-in until a device "
    "benchmark on three real scans confirms accuracy, time and memory. The adapter contract and this harness are the "
    "artefacts; the engine choice remains replaceable.",
]
open(os.path.join(docs, "OCR-EVALUATION.md"), "w", encoding="utf-8").write("\n".join(md))
print("\n".join(md))
