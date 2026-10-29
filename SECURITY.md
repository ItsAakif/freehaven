# Security policy

## Supported versions

The `beta` branch is the active development line. There is no production release yet.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** (Security → Report a vulnerability) on
`ItsAakif/freehaven`. Do not open a public issue for anything that could expose user data or bypass a security
control.

Include the affected version/commit, Android or iOS version, reproduction steps and impact. Please do not include
real API keys, personal documents or other people's data.

## Secrets

- Freehaven bundles no API keys, signing keys or service credentials.
- A user-supplied model key is stored with `expo-secure-store` and never written to the database, logs or exports.
- CI uses only the public Android SDK and `npm ci` against the committed lockfile. It has `contents: read`
  permissions and needs no repository secrets.
- Release signing credentials, if introduced later, must live in GitHub Actions secrets and never in the repository.

## Data handling

Documents, extracted text, notes, highlights, cards and conversations are stored locally in SQLite and the app
filesystem. Nothing is uploaded unless the user configures a remote model or speech provider, in which case the
request is disclosed in the UI.

## Scope

The app is a client. Issues in third-party providers (model endpoints, catalogue APIs, TTS services) should be
reported to those providers; we will still document mitigations on our side.
