/**
 * OCR evaluation harness (Node, dev-only).
 *
 * Runs Tesseract.js over the three synthetic fixtures and records wall time,
 * confidence and process RSS. This is an offline benchmark of the engine, not a
 * device measurement: React Native memory and speed will differ.
 */
import { createWorker } from 'tesseract.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', 'docs', 'ocr-fixtures');
const files = ['clean.png', 'lowcontrast_skew.png', 'dense_columns.png'];

const worker = await createWorker('eng', 1, { logger: () => {} });
const results = [];

for (const file of files) {
  const full = path.join(fixtures, file);
  const bytes = fs.statSync(full).size;
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();
  const { data } = await worker.recognize(full);
  const elapsed = performance.now() - started;
  const rssAfter = process.memoryUsage().rss;
  results.push({
    file,
    bytes,
    ms: Math.round(elapsed),
    rssBeforeMB: Math.round(rssBefore / 1048576),
    rssAfterMB: Math.round(rssAfter / 1048576),
    rssDeltaMB: Math.round((rssAfter - rssBefore) / 1048576),
    confidence: data.confidence,
    text: data.text,
  });
  console.log(`${file}: ${Math.round(elapsed)} ms, confidence ${data.confidence}`);
}

await worker.terminate();
fs.writeFileSync(
  path.join(here, '..', 'docs', 'ocr-results.json'),
  JSON.stringify(
    {
      engine: 'tesseract.js',
      version: JSON.parse(fs.readFileSync(path.join(here, '..', 'node_modules', 'tesseract.js', 'package.json'), 'utf8')).version,
      languages: ['eng'],
      node: process.version,
      platform: process.platform,
      note: 'Synthetic fixtures, Node runtime. Not a mobile measurement.',
      results,
    },
    null,
    2,
  ),
);
console.log('wrote docs/ocr-results.json');
