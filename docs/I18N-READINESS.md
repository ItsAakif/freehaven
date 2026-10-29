# Multilingual UI readiness — review

## Current state

| Area | State |
|---|---|
| UI copy | **English only.** Strings are inline in components; there is no message catalogue. |
| Dates and numbers | Use `toLocaleDateString` / `toLocaleString`, so they follow the device locale. |
| Narration | 8 languages (`en-US`, `en-GB`, `es-ES`, `fr-FR`, `de-DE`, `pt-BR`, `it-IT`, `ja-JP`), independent of UI language. |
| Content | Catalogue language metadata is stored per book (`books.language`); the reader renders any script the platform font supports. |
| Fonts | System serif/sans; no bundled Latin-only display face, so CJK/Arabic fall back to platform fonts. |
| RTL | Not handled. The layout relies on default flex direction and does not call `I18nManager.allowRTL` or mirror icons. |
| Pluralisation | Ad-hoc (`${count} cards`), not a plural-rule implementation. |

## What would be required

1. Extract ~350 inline strings into `locales/en.json` with stable keys.
2. Add `expo-localization` for device locales and a small `t(key, params)` layer (or `i18next`/`react-i18next` if plural rules and interpolation are needed).
3. Convert dates/relative times to `Intl.RelativeTimeFormat` with the active locale rather than hand-written `"3h ago"`.
4. Add RTL: `I18nManager.forceRTL` per locale, mirror directional icons (`chevron-forward` → `chevron-back`), audit the reader WebView CSS for logical properties.
5. Plural rules for cards/minutes/days; the current UI has several count strings that would need ICU messages.
6. Screenshot/QA pass at 30–40% extra string length (German), and at CJK line heights.

## What is already translation-friendly

- No text is baked into images or icons (the brand mark is abstract).
- All colours, spacing and type come from tokens, so a language with taller glyphs only needs line-height adjustments.
- Narration language is separate from UI language, which is the correct model for a learning app.
- Content generation is provider-driven; prompts are English but the source text can be any language.

## Decision

Translation is **not started** and is not claimed. The app is honest about this: the README and requirement matrix mark multilingual UI as partial. The highest-value next step is extracting strings, because doing it after more screens are added increases the cost linearly. It is deliberately deferred until the UI stabilises, and before any non-English release.
