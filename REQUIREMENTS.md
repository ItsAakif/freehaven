# Requirement traceability

Status legend: **Done** (implemented and covered), **Partial** (implemented with a documented gap),
**Not started**, **Blocked** (environmental or provider limitation).

Paths are relative to `freehaven/`. Test suites live beside the code under `__tests__/`.

## Summary

| Area | Done | Partial | Not started | Blocked |
|---|---|---|---|---|
| A. Discovery | 9 | 0 | 0 | 0 |
| B. User content | 6 | 3 | 0 | 0 |
| C. Reading | 10 | 3 | 1 | 0 |
| D. Summaries | 9 | 1 | 0 | 0 |
| E. Audio | 8 | 5 | 1 | 0 |
| F. AI assistant | 9 | 4 | 0 | 0 |
| G. Personalised learning | 6 | 4 | 0 | 0 |
| H. Voice | 1 | 1 | 3 | 0 |
| I. Mindspace | 7 | 1 | 1 | 0 |
| J. Retention | 8 | 0 | 1 | 0 |
| K. Offline | 7 | 1 | 0 | 0 |
| L. Accessibility & settings | 4 | 4 | 0 | 0 |

## A. Book discovery and catalogue

| ID | Requirement | Status | Implementation | Tests |
|---|---|---|---|---|
| A1 | Search by title, author, ISBN, subject | Done | `src/providers/catalogue/*`, `src/app/(tabs)/browse.tsx` | `catalogue.test.ts` |
| A2 | Browse by category/topic | Done | `src/app/(tabs)/discover.tsx`, subject preset from Browse | `catalogue.test.ts` |
| A3 | Book details, edition info, previews | Done | `src/app/book/[id].tsx` | manual |
| A4 | Legitimate reading/borrowing/purchase links | Done | `access` enum + `externalUrl` via `expo-web-browser` | `catalogue.test.ts` |
| A5 | Save to personal library | Done | `repositories/books.ts` (`setInLibrary`) | `repositories.test.ts` |
| A6 | Covers under provider terms | Done | provider CDN URLs, attribution strings | manual |
| A7 | Pagination, caching, retry, graceful failure | Done | `src/lib/http.ts`, `searchCatalogue` with `allSettled` | `catalogue.test.ts` |
| A8 | Distinguish metadata from ebook access | Done | `access` + UI badges | `catalogue.test.ts` |
| A9 | Replaceable metadata providers | Done | `CatalogueProvider` interface + registry | `catalogue.test.ts` |

## B. User-provided content

| ID | Requirement | Status | Implementation | Notes |
|---|---|---|---|---|
| B1 | Import PDF and EPUB | Done | `features/imports/{epub,pdf,service}.ts` | `epub.test.ts`, `pdf.test.ts`, `buildExtraction.test.ts` |
| B2 | Links to accessible documents | Done | `features/imports/url.ts` (SSRF guards, size cap) | no unit test yet |
| B3 | Manual book/source creation | Partial | `createManualBook()` exists; UI offers pasted text + title | dedicated manual-book form not built |
| B4 | Validate formats, corrupt and oversized files | Done | `detectFormat`, 80 MB cap, parser errors | `buildExtraction.test.ts`, `epub.test.ts`, `pdf.test.ts` |
| B5 | Extract text and metadata | Done | same as B1 | same |
| B6 | Preserve pages, chapters, source locations | Done | sections + character offsets + page numbers | `buildExtraction.test.ts` |
| B7 | Detect scanned PDFs, optional OCR | Partial | detection + explicit message; OCR adapter + benchmark (`docs/OCR-EVALUATION.md`), engine disabled | OCR post-pass/engine not enabled |
| B8 | Save imported documents in library | Done | `importDocument` → `setInLibrary` | `repositories.test.ts` |
| B9 | Processing status and recovery | Partial | `documents.status`, `jobs` table, idempotent hash | no resume-after-crash worker |

## C. Reading experience

| ID | Requirement | Status | Implementation | Notes |
|---|---|---|---|---|
| C1 | EPUB chapter navigation and TOC | Done | `src/app/read/[id].tsx`, TOC sheet | |
| C2 | Font size, typography, spacing, margins | Partial | size, line height, serif/sans, max width | margins not user-adjustable |
| C3 | Reading themes | Done | `readerHtml.ts` three palettes | |
| C4 | Persistent position and progress | Done | `reading_positions`, debounced scroll | |
| C5 | Bookmarks | Done | reader add + Mindspace bookmark list | `reading.ts` |
| C6 | Text selection and highlights | Done | WebView selection bridge, locator model | `readerHtml.test.ts` |
| C7 | Annotations and notes | Done | highlight note sheet | `repositories.test.ts` |
| C8 | Search within the book | Done | FTS5 `searchBookChunks` | `schema.test.ts` |
| C9 | Resume reading | Done | locator restore | |
| C10 | PDF page navigation and progress | Done | page sections, prev/next | |
| C11 | Zoom, fit-to-width | Partial | system viewer for true layout | no in-app zoom |
| C12 | PDF text selection and search | Done | text layer + FTS | `pdf.test.ts` |
| C13 | PDF bookmarks and annotations | Done | locator per page section | |
| C14 | OCR for scanned pages | Not started | – | requires a Tesseract-class engine |
| C15 | Source references preserving page numbers | Done | `chunk.page` through citations | `buildExtraction.test.ts` |
| C16 | Maintained cross-platform reader; native bridge if needed | Done | WebView + generated document + JS bridge, documented in `ARCHITECTURE.md` | |

## D. Summaries and lessons

| ID | Requirement | Status | Implementation | Notes |
|---|---|---|---|---|
| D1 | Concise book summaries | Done | `features/learning/generate.ts` + AI providers | `ai.test.ts` |
| D2 | Chapter summaries | Done | chapter picker + `summariseChapter` | `stage2.test.ts` |
| D3 | Key takeaways | Done | `task: 'takeaways'` | `ai.test.ts` |
| D4 | Concepts and definitions | Done | “Concepts” generation via `extractConcepts` (local, cited) | `concepts.test.ts` |
| D5 | Actionable lessons | Done | `task: 'lesson'` template with practice prompt | `ai.test.ts` |
| D6 | Structured outlines | Partial | lesson headings; no outline editor | |
| D7 | Length controls | Done | short/medium/long in the generate sheet | |
| D8 | User-editable summaries | Done | edit/save in `summary/[id]` | |
| D9 | Provenance and generation metadata | Done | provider, model, created_at, source links | |
| D10 | Lawful generation only | Done | generation restricted to indexed owned/public-domain text | |

## E. Audio

| ID | Requirement | Status | Implementation | Notes |
|---|---|---|---|---|
| E1 | Narration of imported documents | Done | `listen/[id].tsx` + `expo-speech` | |
| E2 | Audio of summaries and lessons | Done | speak action on `summary/[id]` | |
| E3 | Configurable speed | Done | 0.75–1.5× | |
| E4 | Seek controls and progress persistence | Partial | studio mode seeks ±15 s; device TTS is section/part based | |
| E5 | Background playback | Partial | expo-audio background mode + lock-screen registration in studio mode | TTS background needs a dev build + device |
| E6 | Lock-screen and headset controls | Partial | `setActiveForLockScreen` for studio MP3 playback | only when a remote speech provider is configured |
| E7 | Playback queue | Partial | persisted `audio_queue` with status/file/duration | no manual reorder |
| E8 | Sleep timer | Done | 15/30/45/60 min | |
| E9 | Audio caching and downloads | Done | remote synthesis cached as MP3 by content hash (`features/audio/providers.ts`) | `stage3.test.ts` |
| E10 | Resume after interruption | Partial | position persisted per section/part and queue row | |
| E11 | Chapter/section navigation | Done | prev/next + persisted queue | |
| E12 | Configurable speech provider and voice | Done | device voice picker + studio provider/voice | `stage3.test.ts` |
| E13 | Multiple languages | Done | 8 narration languages, filtered device voices | `stage3.test.ts` |
| E14 | Multi-speaker AI lessons | Not started | – | needs a synthesis provider |

## F. AI learning assistant

| ID | Requirement | Status | Implementation | Notes |
|---|---|---|---|---|
| F1 | Ask about books and documents | Done | `askBook()` + chat screen | |
| F2 | Explain selected passages | Partial | citation quote sheet; no direct "explain selection" | |
| F3 | Summaries, examples, revision notes | Partial | summaries/lessons; examples as a task not exposed | |
| F4 | Create quizzes and flashcards | Done | `generateCards`, MCQ generation | `learning-logic.test.ts` |
| F5 | Follow-up questions and history | Done | conversations/messages | `repositories.test.ts` |
| F6 | Grounded in source content | Done | retrieval → provider → citations | `ai.test.ts` |
| F7 | Citations and page/chapter refs | Done | citation chips, page numbers | |
| F8 | Inspect supporting passages | Done | citation sheet with quote | |
| F9 | Validate generated output | Done | citation id + quote filtering | `ai.test.ts` |
| F10 | Missing evidence and uncertainty | Done | abstain text, no fabricated answer | `ai.test.ts` |
| F11 | Fallback when remote AI unavailable | Done | extractive provider, labelled degraded | `ai.test.ts` |
| F12 | Provider-independent interface, future local inference | Done | `AiProvider` contract; extractive implementation | local LLM runtime not bundled |
| F13 | Never hardcode API keys | Done | SecureStore only | |
| F14 | Disclose remote sending | Done | provider chip in chat + settings copy | |

## G. Personalised learning and assessment

| ID | Requirement | Status | Implementation | Notes |
|---|---|---|---|---|
| G1 | Onboarding by goals/preferences | Done | `onboarding.tsx` (goal, topics, familiarity, target) | `stage2.test.ts` |
| G2 | Assessment of existing knowledge | Partial | self-rated familiarity per topic; no scored diagnostic | |
| G3 | Structured learning plans | Done | plans + plan items + path screen | |
| G4 | Daily goals and lesson length | Done | target surfaced on Today and Settings; reading/reviews log minutes | `stage2.test.ts` |
| G5 | Personalised recommendations | Partial | explainable “For you” row from onboarding subjects + shelf | not history-based |
| G6 | Adaptive sequencing | Partial | rule-based re-ordering from assessment + progress, with a visible reason | not ML |
| G7 | Knowledge checks | Done | cards + MCQ | |
| G8 | Streaks and achievements | Partial | streak + 7-day strip | no achievements |
| G9 | Progress by topic/path | Done | topic mastery bars + path completion | `stage2.test.ts` |
| G10 | Continuation on Today | Done | continue card + resume | |

## H. Voice interaction

| ID | Requirement | Status | Implementation |
|---|---|---|---|
| H1 | Text conversation grounded in source | Done | chat screen |
| H2 | Push-to-talk | Not started | microphone permission reserved |
| H3 | Spoken AI responses | Partial | any summary can be spoken; chat answers not auto-spoken |
| H4 | Real-time conversational voice | Not started | deliberately deferred (cost/latency/privacy) |
| H5 | Coaching feedback | Not started | |

## I. Mindspace

| ID | Requirement | Status | Implementation | Notes |
|---|---|---|---|---|
| I1 | Searchable notes | Done | Mindspace search over quotes/notes | |
| I2 | Source-linked highlights | Done | locator + book title | |
| I3 | Saved AI responses | Done | “Save passage” on answers + conversation history |
| I4 | Bookmarks | Done | Mindspace list with jump-back |
| I5 | Personal annotations | Done | highlight notes | |
| I6 | Learning history | Done | activity timeline (read/listen/review/highlight/lesson/chat/import/bookmark) | `stage2.test.ts` |
| I7 | Tags/folders | Partial | bookmark folders + tags implemented; notes are untagged | |
| I8 | Links between notes and paths | Not started | – | |
| I9 | Export of personal data | Done | JSON export via share sheet | |

## J. Flashcards, quizzes and retention

| ID | Requirement | Status | Implementation | Notes |
|---|---|---|---|---|
| J1 | Generated and manual cards | Done | `generateCards`, `addCards` | |
| J2 | MCQ and short answer | Done | `kind: basic | mcq` | |
| J3 | Explanations | Done | `explanation` field | |
| J4 | Source references | Done | `source_chunk_id` + review quote | |
| J5 | Editing and deletion | Done | review edit sheet | |
| J6 | Daily revision queue | Done | `dueCards` | |
| J7 | FSRS scheduling | Done | `domain/fsrs.ts` | `fsrs.test.ts` |
| J8 | Review history and scheduling | Done | `reviews` table, `reviewStats` | `repositories.test.ts` |
| J9 | Topic-level mastery | Not started | metrics computed but not surfaced | |

## K. Offline access

| ID | Requirement | Status | Implementation |
|---|---|---|---|
| K1 | Offline reading | Done | local files + DB |
| K2 | Local bookmarks/notes/highlights | Done | SQLite |
| K3 | Saved summaries and lessons | Done | SQLite |
| K4 | Downloaded audio | Done | “Download audio” pre-synthesises every section into the queue cache | `download.test.ts` |
| K5 | Flashcard revision | Done | SQLite + FSRS |
| K6 | Recovery after restart | Done | persisted positions + DB |
| K7 | Download status and storage | Partial | storage usage shown; no media downloads |
| K8 | Cache management | Done | storage usage + Clear cache action |

## L. Accessibility, settings, reliability

| ID | Requirement | Status | Implementation | Notes |
|---|---|---|---|---|
| L1 | Light/dark/reading themes | Done | theme provider | |
| L2 | Text and playback preferences | Done | settings | |
| L3 | Language preferences | Partial | UI English; TTS fixed `en-US` | |
| L4 | Storage and download management | Partial | usage display | no purge action |
| L5 | Privacy settings | Partial | no analytics SDK; AI config + disclosure | no granular toggles |
| L6 | Export and deletion of data | Done | JSON export + transactional delete | |
| L7 | Network and inference status | Done | provider chip + offline copy | |
| L8 | Accessible controls and screen readers | Partial | roles/labels/targets + contrast audit (`docs/ACCESSIBILITY.md`) | no device TalkBack/VoiceOver run |
| L9 | Error handling and recovery | Done | error states, retry, transactional writes | |

## Next implementation order

1. Bookmarks screen + saved-AI-response action (closes C5, I3, I4).
2. Onboarding goal capture + daily target surfaced on Today (G1, G4).
3. Summary length/kind controls and chapter-level summaries (D2, D6, D7).
4. TTS language/voice selection; optional file-based audio with expo-audio and a cache (E6, E9, E12, E13).
5. Push-to-talk chat with `expo-speech-recognition` (H2, H3).
6. OCR pipeline behind a replaceable adapter (B7, C14).
7. Device verification: Android emulator run, TalkBack pass, playback interruption tests, migration on upgrade.
