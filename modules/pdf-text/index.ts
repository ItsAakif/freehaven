/**
 * Local Expo module: native PDF text extraction (PdfBox-Android).
 *
 * `requireOptionalNativeModule` returns null on web, iOS and Expo Go, so the
 * exports below never throw there. `extractPdfPages` returns the raw JSON
 * string produced by the Kotlin module (`[{ page, text }]`) and null when the
 * native side is unavailable or fails. Callers that want typed pages should
 * use `src/features/imports/pdfNative.ts`.
 */

import { requireOptionalNativeModule } from 'expo-modules-core';

type PdfTextNativeModule = {
  /** Extracts every page as a JSON array string: `[{ "page": 1, "text": "" }]`. */
  extractPages(path: string): Promise<string>;
  /** Extracts the document outline as JSON: `[{ "title": "1. Intro", "page": 14 }]`, 1-based. */
  extractOutline(path: string): Promise<string>;
};

let nativeModule: PdfTextNativeModule | null = null;
try {
  nativeModule = requireOptionalNativeModule<PdfTextNativeModule>('PdfText');
} catch {
  // Missing registration is expected on web, iOS and Expo Go.
  nativeModule = null;
}

export function isPdfTextAvailable(): boolean {
  return nativeModule != null;
}

export async function extractPdfPages(path: string): Promise<string | null> {
  if (!nativeModule) return null;
  try {
    return await nativeModule.extractPages(path);
  } catch {
    // The file may have moved, be encrypted or be corrupt; the JS caller falls
    // back to the content-stream parser in that case.
    return null;
  }
}

export async function extractOutline(path: string): Promise<string | null> {
  if (!nativeModule) return null;
  try {
    return await nativeModule.extractOutline(path);
  } catch {
    return null;
  }
}

export type { PdfTextNativeModule };
