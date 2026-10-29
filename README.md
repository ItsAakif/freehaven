# Freehaven

[![Android beta](https://github.com/ItsAakif/freehaven/actions/workflows/android-beta.yml/badge.svg?branch=beta)](https://github.com/ItsAakif/freehaven/actions/workflows/android-beta.yml)

A calm, local-first learning app for the books and documents you already own.

Freehaven turns reading into a loop: **import → read & annotate → summarise / listen → ask → practise → remember**.
It is free, open source, account-free, ad-free, and works offline. There is no proprietary catalogue: public-domain
books come from Project Gutenberg, everything else is either your own file or a link to its official source.

Freehaven was designed after a static study of BeFreed and StoryShots (see `../research/`). It keeps what those apps
prove people want — immersive reading, generated lessons, narration, conversation, spaced repetition — and drops what
they get wrong: server-only generation, stacked paywalls, ad-gated AI, retention alarms and content lock-in.

---

## What works today

**Library & discovery**
- Search Project Gutenberg, Open Library and Google Books by title, author, ISBN or subject, with pagination,
  in-memory caching, timeout/retry and graceful per-provider failure.
- Clear separation of metadata, previews, public-domain downloads and external access links.
- Personal library, save/remove, covers, progress.

**Import**
- EPUB (OPF/spine/TOC parsing, sanitised HTML, chapter text), PDF (content-stream text extraction with page numbers),
  plain text, pasted text and web articles (SSRF-guarded, size-capped, HTML → readable text).
- Extraction is transactional: a failed import never leaves half a book behind. Extracted text is chunked with
  character offsets for citations.

**Reader**
- Clean, themed, reflowing text reader (warm/light/dark), adjustable size, spacing and typeface.
- Chapter navigation, in-book full-text search, bookmarks, persisted position and progress.
- Text selection → highlight with optional note; highlights are stored as stable locators and re-rendered on open.
- PDF pages keep their page numbers; the original file can be opened in the system viewer for layout fidelity.

**Learning**
- Onboarding captures a goal, subjects, a self-rated familiarity per subject and a daily target; Today redirects on
  first run and shows `minutes / target` (reading minutes derived from position deltas, reviews counted too).
- Summaries, key takeaways, structured lessons **and chapter summaries** generated **on device** by default
  (deterministic extractive summariser) or by any OpenAI-compatible endpoint, with short/medium/long length control.
- Every generated artefact links back to the passages it came from.
- Flashcard and multiple-choice generation from source text, manual editing/deletion, and a daily review queue
  scheduled with an in-repo **FSRS-5** implementation (deterministic, no interval fuzzing).
- Source-grounded Q&A with citations, abstention when the text does not support an answer, and citation validation
  that rejects fabricated references.
- Learning paths built from a goal, then **re-ordered from your self-assessment, progress and book length** with a
  visible reason per item.
- Topic and per-book mastery bars, plus a unified activity timeline.

**Listening**
- Section-by-section narration with the device speech engine, **8 languages and device voice selection**, speed
  control, sleep timer, resume and progress sync.
- Optional **studio narration** through an OpenAI-compatible `/audio/speech` endpoint: MP3s cached by content hash,
  played with `expo-audio`, lock-screen metadata and ±15 s seek. Device narration still works with no key and no
  network.

**Mindspace & data**
- Searchable highlights, notes, conversations and lessons in one place, with **bookmark folders and tags**.
- Activity timeline of reads, reviews, highlights, lessons, chats and imports.
- Export everything as JSON; delete everything with one confirmed action.
- Optional daily review reminder via a local notification. No server involved.

---

## Screens

| Tab | Purpose |
|---|---|
| **Today** | Greeting, streak, continue-reading, review queue with a 7-day activity strip, free classics, recent notes and lessons. |
| **Discover** | Learning paths, goal-based path builder, curated public-domain rows by subject, shelf. |
| **Browse** | Catalogue search across three providers, filters, save, details. |
| **Mindspace** | Highlights, notes, conversations, lessons, search, export entry point. |
| **Create** | Import file/link/text, build a learning path, per-book read/listen/ask shortcuts. |

Flow screens: book detail, reader, listener, AI chat, lesson, review, learning path, import, settings.

---

## Stack

| Concern | Choice | Licence |
|---|---|---|
| App framework | Expo SDK 58 / React Native 0.88 / React 19, TypeScript strict | MIT |
| Routing | expo-router (file-based, typed) | MIT |
| Local data | expo-sqlite (SQLite + FTS5), schema migrations in code | MIT |
| Files | expo-file-system (new `File`/`Directory` API) | MIT |
| Reader surface | react-native-webview with a generated, sanitised document + selection bridge | MIT |
| Import | jszip, fast-xml-parser, pdf-lib, pako | MIT / MIT / MIT / MIT |
| Speech | expo-speech (device TTS) | MIT |
| Audio (future file playback) | expo-audio (configured for background playback) | MIT |
| Notifications | expo-notifications (local only) | MIT |
| Secrets | expo-secure-store | MIT |
| State | zustand + expo-sqlite/kv-store persistence | MIT |
| Tests | Jest + jest-expo, better-sqlite3 for repository tests | MIT |

No dependency requires an account, a paid key or a proprietary backend.

---

## Quick start

```bash
cd freehaven
npm install
npx expo start          # Expo Go is enough for the core app
```

A **development build** is recommended for the full native surface (background audio, notification channel config,
custom splash/icon):

```bash
npx expo run:android    # requires Android SDK + device/emulator
npx expo run:ios        # requires macOS
# or: npx eas-cli@latest build --profile development
```

### Quality gates (run before any release)

```bash
npx tsc --noEmit        # 0 errors
npx eslint .            # 0 errors
npx jest --runInBand    # 91 tests, 16 suites
npx expo-doctor         # 20/20 checks
npx expo export --platform android   # production Hermes bundle
```

---

## Beta and continuous integration

- `beta` is the integration branch. `main` is protected and reserved for reviewed, release-ready code.
- Every push and pull request targeting `beta` runs `.github/workflows/android-beta.yml`:
  typecheck, lint, Jest, Expo Doctor, `expo prebuild`, and **arm64 beta APKs**.
- The artifact `freehaven-beta-<sha>` contains:
  - `app-release.apk` — standalone, JavaScript embedded, signed with the **debug keystore**. Install this on a phone.
  - `app-debug.apk` — development build; requires a Metro server (`npx expo start`) and is not standalone.
- The artifact is retained for 14 days and is never committed.
- There is no production release, Play Store publishing or promotion to `main` yet.
- Install the standalone build with `adb install -r app-release.apk`.

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the branch rules and [`SECURITY.md`](./SECURITY.md) for reporting.

## Architecture at a glance

```
src/
  app/            expo-router routes (tabs + book/read/listen/chat/summary/review/plan/import/settings)
  design/         tokens, theme provider, UI primitives, Markdown renderer
  data/           SQLite driver, migrations, repositories, DatabaseProvider
  domain/         types, FSRS scheduler, text pipeline, retrieval, quiz generation
  features/       imports (epub/pdf/url/service), reader HTML, learning actions, data export
  providers/      catalogue providers (Gutenberg, Open Library, Google Books)
  ai/             provider contract, extractive engine, OpenAI-compatible client, key storage
  state/          persisted preferences
  hooks/          async resource hook
```

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for diagrams, the schema and the reasoning.
See [`REQUIREMENTS.md`](./REQUIREMENTS.md) for the requirement-to-code traceability matrix.
See [`docs/STATUS.md`](./docs/STATUS.md) for the current milestone report and known blockers.
See [`docs/ANDROID-BUILD.md`](./docs/ANDROID-BUILD.md) for the SDK setup, build result and device checklist.
See [`docs/OCR-EVALUATION.md`](./docs/OCR-EVALUATION.md) and [`docs/ACCESSIBILITY.md`](./docs/ACCESSIBILITY.md) for the
Stage 4 evaluations.

---

## Content policy

- Freehaven **hosts nothing**. Public-domain texts are downloaded from Project Gutenberg at the user's request.
- Open Library and Google Books are used for **metadata and discovery**; their terms forbid treating them as a
  source of unrestricted ebook downloads, and Freehaven does not.
- Imported files remain the user's responsibility. Import is not a copyright exemption.
- Generated summaries cite their sources and are labelled with the provider that produced them.
- Cover images are loaded from the provider's CDN under that provider's terms.

## Privacy

- No account, no analytics SDK, no advertising ID, no telemetry.
- Documents, extracted text, embeddings (none yet), notes and reviews stay in the local SQLite database and app
  filesystem.
- AI is **on device by default**. If you configure a remote endpoint, the app clearly shows the provider and sends
  only the retrieved passages needed for the request. Your key is stored in the device keychain and never bundled.

## Known limitations

- **No device or emulator verification was possible.** The Android SDK was installed and the native project prebuilt
  during this pass; `docs/ANDROID-BUILD.md` records the build result, install commands and a 12-point device
  checklist. Typecheck, lint, 91 tests, Expo Doctor and a production bundle pass.
- PDF support is a **text-layer reader**. Scanned PDFs are rejected with a clear message. An OCR adapter exists but
  **no engine is enabled**; see `docs/OCR-EVALUATION.md` (clean print about 99.8 percent char accuracy, two-column pages about 47 percent because reading order is lost).
- EPUB rendering is semantic reflow (paragraphs, headings, emphasis), not publisher layout fidelity.
- Studio narration is unverified on hardware; device TTS has no lock-screen transport.
- Adaptive sequencing is rule-based and explainable, not machine-learned.
- No sync between devices. Export/import JSON is the portability path.
- Real-time voice conversation is not implemented; the staged plan is documented in `REQUIREMENTS.md` (§H).

## License

MIT. The project was scaffolded from the Expo template (MIT, Â© 650 Industries); all application code is original.


