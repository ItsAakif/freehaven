# Implementation status — 2026-10-29

## Milestones

| Milestone | State | Evidence |
|---|---|---|
| M1 Foundation | **Complete** | Expo SDK 58 app, design system, 5-tab shell, SQLite schema + migrations, error boundary, Jest harness |
| M2 Library & discovery | **Complete** | 3 catalogue providers, search/pagination/retry, book detail, library, EPUB/PDF/text/URL import, offline storage |
| M3 Reader | **Complete (text-reflow)** | TOC, themes, type controls, position, bookmarks (+folders/tags), highlights + notes, in-book FTS, PDF page reader + system viewer |
| M4 Learning engine | **Complete (core)** | Extractive + remote summaries/lessons/takeaways/chapters, card generation, FSRS review, paths, Today/Discover/Mindspace wiring, onboarding + daily targets + mastery + timeline |
| M5 Audio | **Substantial** | Device TTS with language/voice, studio MP3 synthesis + hash cache, lock-screen transport, persisted queue, speed, sleep timer, progress |
| M6 AI & personalisation | **Partial** | Grounded chat, provider abstraction, secure key, offline fallback, self-assessment-driven ordering; no adaptive ML, no voice chat |
| M7 Retention & completion | **Partial** | FSRS queue, export/delete, accessibility audit, OCR evaluation, docs; device validation blocked |

## What was built

- **Foundation** — Expo Router with five tabs, three-palette design system (light/dark/warm), 18 reusable components,
  splash/icon identity generated from a small arch-with-sun mark, persisted preferences.
- **Data** — 20-table SQLite schema with FTS5 and triggers, versioned migrations that refuse newer databases,
  driver abstraction (Expo SQLite in the app, better-sqlite3 in tests), repositories for books, reading, learning,
  mindspace.
- **Discovery** — Project Gutenberg (full public-domain texts), Open Library and Google Books behind one interface,
  merged and de-duplicated, per-provider failure isolation, pagination, TTL cache, retries.
- **Import** — EPUB (container → OPF → spine → sanitised XHTML → text), PDF (content streams, Flate, Tj/TJ,
  page numbers, scanned-file detection), plain text, pasted text, and SSRF-guarded URL ingestion. Import is
  transactional and idempotent by file hash.
- **Reader** — generated HTML with stable character offsets, WebView selection bridge, highlight wrapping without
  reload, notes, TOC, FTS result jumping, persisted progress, PDF original-file escape hatch.
- **Learning** — source sampling across the whole document, extractive summaries/lessons/takeaways, optional
  OpenAI-compatible provider with strict citation filtering, grounded chat with abstention, card + MCQ generation.
- **Retention** — FSRS-5 implemented in-repo with deterministic tests, due queue, four-grade review with interval
  preview, review log, streak and 7-day activity.
- **Data ownership** — JSON export of 15 tables, confirmed deletion of all library data, storage usage display.

## Stage 2–4 additions (this pass)

- **Onboarding** (`src/app/onboarding.tsx`): goal, subject selection, self-rated familiarity, daily target;
  Today redirects on first run.
- **Daily target**: reading minutes are derived from position deltas and reviews; Today shows `minutes / target`
  and Settings can change it.
- **Adaptive paths**: `rebuildPlanSequence()` orders by self-assessment, then progress, then length, and writes a
  visible reason per item; the plan screen exposes “Re-optimise order”.
- **Mastery**: per-book and per-topic aggregates (`repositories/mastery.ts`) surfaced as bars in Mindspace.
- **Timeline**: `activity_events` records read/listen/review/highlight/lesson/chat/import/bookmark.
- **Summaries**: generate sheet with kind (summary/takeaways/lesson/chapter) and length; chapter summaries stored with
  `section_id`.
- **Bookmarks**: folders + tags in the reader sheet, folder filter and tags in Mindspace.
- **Audio**: language and device-voice selection; optional studio narration through an OpenAI-compatible
  `/audio/speech` endpoint with content-hash MP3 cache, lock-screen metadata, ±15 s seek, speed and persisted
  `audio_queue` rows; **Download audio** pre-caches every section for offline listening.
- **Concepts**: local definition extraction rendered as a cited “Concepts” artefact.
- **For you**: Discover row derived from the onboarding subject, labelled with the reason.
- **OCR**: `OcrEngine` adapter with a disabled default and a measured evaluation of Tesseract.js on three synthetic
  scans (`docs/OCR-EVALUATION.md`).

## Tests and gates (last run)

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npx tsc --noEmit` | **0 errors** |
| Lint | `npx eslint .` | **0 errors, 0 warnings** |
| Unit/integration | `npx jest --runInBand` | **91 passed / 16 suites** |
| Dependency health | `npx expo-doctor` | **20/20 checks** |
| Production bundle | `npx expo export --platform android` | **succeeded** (Hermes bundle ~6.3 MB) |
| Debug APK | `gradlew assembleDebug` | **not produced** — stopped by request; findings in `docs/ANDROID-BUILD.md` |
| Device install | `adb install` | **blocked** – no device; hardware virtualisation disabled |
| iOS build | `npx expo run:ios` | **blocked** — Windows host |

Test coverage by area: FSRS (7), text pipeline (6), retrieval/quiz (8), schema/FTS/cascade/WAL (6), repositories (7),
reader HTML (5), EPUB (4), PDF (4), import builder (4), catalogue (7), AI providers (9).

## Known defects

1. **PDF text extraction is best-effort.** Object-stream PDFs fall back to stream order, so page association can be
   approximate. CID/Type0 fonts may yield mojibake (detected and warned). Scanned PDFs are rejected; OCR is an
   adapter with no engine enabled.
2. **Reader does not render publisher CSS.** EPUB layout (columns, floats, fixed pages) is normalised to reflowing
   text. This is intentional, but it is not a facsimile.
3. **Studio narration is unverified on hardware.** MP3 caching, lock-screen transport and background behaviour need a
   development build and a device; device TTS has no lock-screen transport.
4. **Adaptive sequencing is rule-based**, not learned. It is explainable and reversible, but do not describe it as ML.
5. **No device run.** Any platform-specific defect in the WebView bridge, notification scheduling, SecureStore,
   speech, audio session or file copying is unverified.

## Blockers

| Blocker | Impact | Workaround |
|---|---|---|
| No Android SDK / AVD / device | Cannot verify runtime, permissions, playback, DB migration on upgrade | Typecheck + unit/integration tests + production export; document for the next machine |
| No macOS | Cannot build iOS | Expo prebuild/EAS path documented |
| No TTS synthesis provider configured | No downloadable audio or multi-speaker lessons | Device TTS is fully offline and always available |

## Immediate next steps

1. Run an Android emulator session: cold start, import a Gutenberg EPUB, highlight text, background/foreground TTS,
   kill/relaunch to verify position and migration.
2. Add topic-mastery indicators and a unified activity timeline.
3. Add summary kind/length controls and chapter-level summaries.
4. Add onboarding goal capture and surface the daily target on Today.
5. Add push-to-talk chat (`expo-speech-recognition`) and spoken answers for chat.
6. Decide on OCR adapter (Tesseract WASM vs native) and prototype on three scanned PDFs.

