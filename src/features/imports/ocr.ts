/**
 * OCR seam for scanned PDFs.
 *
 * No engine ships in the app. The benchmark in `docs/OCR-EVALUATION.md` shows
 * Tesseract.js is accurate on clean print but interleaves two-column pages and
 * is too slow/heavy to enable silently on a phone. This adapter keeps the
 * integration point explicit and replaceable: a native ML Kit implementation or
 * a WASM worker can be registered when device measurements justify it.
 */

export type OcrResult = {
  text: string;
  confidence: number;
  engine: string;
};

export interface OcrEngine {
  id: string;
  label: string;
  licence: string;
  /** False means the adapter is present but cannot run in this build. */
  isAvailable(): Promise<boolean>;
  recognize(image: Uint8Array): Promise<OcrResult>;
}

export class OcrUnavailableError extends Error {
  constructor(message = 'OCR is not installed in this build.') {
    super(message);
    this.name = 'OcrUnavailableError';
  }
}

/** Default engine: explicit, honest, and never silently pretends to work. */
export class DisabledOcrEngine implements OcrEngine {
  readonly id = 'disabled';
  readonly label = 'Not installed';
  readonly licence = 'n/a';

  async isAvailable(): Promise<boolean> {
    return false;
  }

  async recognize(): Promise<OcrResult> {
    throw new OcrUnavailableError();
  }
}

let engine: OcrEngine = new DisabledOcrEngine();

export function getOcrEngine(): OcrEngine {
  return engine;
}

/** Test/future seam: register a real engine (native ML Kit or a WASM worker). */
export function setOcrEngine(next: OcrEngine): void {
  engine = next;
}

export async function ocrAvailable(): Promise<boolean> {
  try {
    return await engine.isAvailable();
  } catch {
    return false;
  }
}

/**
 * Column-aware reading order is required before OCR text is merged into chunks:
 * Tesseract emits lines left-to-right across both columns, which corrupts order.
 * This helper splits a page by word x-coordinates when a gutter is detected.
 */
export function orderColumns(
  lines: { text: string; x: number; y: number }[],
  pageWidth: number,
): string[] {
  if (!lines.length) return [];
  const mid = pageWidth / 2;
  const left = lines.filter((l) => l.x < mid).sort((a, b) => a.y - b.y);
  const right = lines.filter((l) => l.x >= mid).sort((a, b) => a.y - b.y);
  const wide = lines.filter((l) => l.x < mid && l.text.length > pageWidth * 0.45);
  if (wide.length > lines.length * 0.3) {
    return [...lines].sort((a, b) => a.y - b.y).map((l) => l.text);
  }
  return [...left, ...right].map((l) => l.text);
}
