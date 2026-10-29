# Configuration

Freehaven needs **no build-time environment variables** and no account. Everything below is configured at runtime on
the device.

## AI provider (optional)

Settings → AI provider:

| Field | Meaning |
|---|---|
| Base URL | Any OpenAI-compatible base, e.g. `https://api.openai.com/v1`, a local llama.cpp server, or an Ollama OpenAI shim |
| Model | Chat model name, e.g. `gpt-4o-mini` |
| API key | Stored with `expo-secure-store`; never exported, never logged, never bundled |

With no provider configured, summaries, lessons, concepts, cards and chat run through the **on-device extractive
engine**. It is deterministic, offline, and always returns citations from the supplied text.

## Studio narration (optional)

Settings → Narration → Studio narration requires the same key and an endpoint that implements
`POST /audio/speech` (OpenAI-compatible). Configure `Speech model` (for example `tts-1`) and `Voice` (for example
`alloy`). Audio is cached as MP3 by a content hash. Device narration needs no key and works offline.

## Notifications

The daily review reminder is a **local** notification (`expo-notifications`). No push service or token is used.

## Storage

| Data | Location |
|---|---|
| Database | app-private SQLite (`freehaven.db`) |
| Imported documents | app documents directory under `library/` |
| Narration cache | app cache under `narration/` and `downloads/` |
| Preferences | `expo-sqlite/kv-store` |

Settings shows usage and can clear the download cache or delete all library data. “Export JSON” writes a file to the
cache directory and opens the system share sheet.

## Environment files

`.env.example` intentionally contains no real configuration. Do not commit `.env`; nothing in the build reads one.
