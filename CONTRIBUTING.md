# Contributing

## Branch model

- `beta` is the integration branch and the only branch automated work may write to.
- `main` is protected and reserved for reviewed, release-ready code. **Do not open pull requests against `main`
  until the maintainer says so.**
- Pull requests target `beta`.
- Never force-push a shared branch.

## Before you open a pull request

```bash
npm ci
npm run typecheck
npm run lint
npm test
npx expo-doctor
```

All five must pass. CI (`.github/workflows/android-beta.yml`) repeats them and builds a debug APK on every push to
`beta` and every PR targeting `beta`.

## What not to commit

- `node_modules/`, `.expo/`, `android/`, `ios/`, `dist*/`, `coverage/`
- APK/AAB files, Gradle caches, keystores, `local.properties`
- `.env` files, API keys, tokens, signing credentials
- Local databases, exported personal data, screenshots containing other people's content
- Books or media you do not have the right to redistribute

The build outputs belong in the GitHub Actions artifact, not in Git.

## Code guidelines

- TypeScript strict; keep `src/domain` pure and unit-tested.
- Repositories own SQL; screens do not write SQL directly.
- Any new database change needs a migration in `src/data/schema.ts` and a test that upgrades from the previous
  version.
- AI output must keep the citation contract in `src/ai/types.ts`: providers receive retrieved sources and return
  chunk ids that exist.
- UI changes must include accessibility labels for interactive elements and respect the design tokens.
- Do not add a dependency without checking its licence and whether Expo Go or a development build is required.

## Commit messages

Use short imperative subjects, for example:

```
feat(reader): keep highlight scroll position
fix(audio): stop device speech when switching sections
ci: cache Gradle between beta builds
```

## Reporting

See `SECURITY.md`. For ordinary bugs, include the commit SHA, Android version and steps to reproduce. Do not attach
copyrighted books.
