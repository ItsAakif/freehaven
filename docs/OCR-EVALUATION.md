# OCR evaluation — Tesseract.js

Engine: `tesseract.js` 7.0.0 · languages: eng · Node v24.19.0 on win32.

> Synthetic fixtures, Node runtime. Not a mobile measurement.

| Fixture | Time | Confidence | Char accuracy | Word error rate | RSS delta |
|---|---|---|---|---|---|
| `clean.png` | 2253 ms | 95 | 99.8% | 0.0% | 14 MB |
| `lowcontrast_skew.png` | 3363 ms | 95 | 100.0% | 0.0% | 5 MB |
| `dense_columns.png` | 4147 ms | 95 | 46.8% | 47.0% | 1 MB |

## Fixtures

- `clean.png` — 1700×2200, 34 px serif, high contrast. Represents a well-produced digital-to-scan export.
- `lowcontrast_skew.png` — grey text, 1.4° rotation, Gaussian blur and JPEG compression.
- `dense_columns.png` — 22 px two-column layout, 104 lines. Tests reading-order handling.

Ground truth is exact by construction (`docs/ocr-fixtures/ground-truth.json`), so accuracy is measured, not estimated.

## Interpretation

- Tesseract.js is usable for clean print, but two-column reading order is a known weakness: it concatenates by line, so a column-aware post-pass is required before chunking pages.
- On a phone the same WASM worker will be slower and heavier than in Node; the numbers above are a lower bound for time and a rough signal for memory, not a mobile benchmark.
- Licence: Tesseract.js and the `eng` traineddata are Apache-2.0. ML Kit (the native alternative) is free to use but its SDK terms are proprietary and it requires a development build.

## Decision

Ship the `OcrEngine` adapter with **no engine enabled by default**. On-device OCR stays opt-in until a device benchmark on three real scans confirms accuracy, time and memory. The adapter contract and this harness are the artefacts; the engine choice remains replaceable.