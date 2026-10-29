# Voice capabilities — investigation and current state

## Implemented now

| Capability | State | Where |
|---|---|---|
| Spoken AI answers | **Yes** | “Read aloud” / “Stop reading” on every assistant message (`src/app/chat/[id].tsx`), using `expo-speech` with the configured narration language |
| Spoken summaries and lessons | **Yes** | “Listen” on a lesson (`src/app/summary/[id].tsx`) |
| Section narration | **Yes** | `src/app/listen/[id].tsx` (device voices or studio MP3) |
| Voice selection | **Yes** | device voice list filtered by language, plus studio model/voice |
| Push-to-talk | **No** | deferred — see below |
| Real-time conversation | **No** | out of scope for the local-first core |

## Push-to-talk: candidate

`expo-speech-recognition` (community, MIT) wraps Android `SpeechRecognizer` and iOS `SFSpeechRecognizer`.
It ships a config plugin, supports partial results and continuous dictation, and does not require a paid service.
It **does** require a development build (not Expo Go) and microphone permission.

Integration shape, if approved:

1. `npx expo install expo-speech-recognition` and add the plugin with a usage description.
2. A `useVoiceInput` hook that exposes `start/stop/partial/error` and degrades to the keyboard when permission is
   denied or the device has no recogniser.
3. A hold-to-talk button in the chat composer: press → start; release → stop, insert the transcript into the input
   (never auto-send, so the user can correct it).
4. Privacy: the recogniser may be cloud-backed on some Android devices; the UI must say “speech may be processed by
   your device’s speech service” and keep the feature opt-in.
5. Tests: pure state machine for start/stop/partial/error; no device test possible here.

Why deferred: it cannot be validated without a device, it adds a native dependency, and the core learning loop does
not depend on it.

## Real-time conversational voice: candidate

The reference app (BeFreed) uses LiveKit Cloud with a server-side agent. Reproducing that requires:

- a LiveKit project and token-minting backend (cost, account, secrets);
- an agent runtime (STT + LLM + TTS) — latency and cost are dominated by the provider;
- a WebRTC native dependency (`@livekit/react-native`), which needs a development build.

Decision: **not part of the core**. A local-first alternative is a turn-based loop (record → on-device STT → local or
remote LLM → TTS) which reuses the existing AI provider and narration layers and works with no account. It is
documented as future work rather than promised.

## Cost / latency / privacy summary

| Approach | Account | Offline | Latency | Privacy |
|---|---|---|---|---|
| Device TTS (`expo-speech`) | no | yes | instant | text stays on device |
| Studio TTS (OpenAI-compatible) | optional key | no (cached after first use) | network + synthesis, 1–5 s per section | text sent to the configured provider |
| Push-to-talk (device recogniser) | no | usually | ~1 s after release | may use the OS speech service |
| Real-time agent (LiveKit) | yes | no | sub-second turn taking | audio leaves the device |

The app never makes a paid service mandatory for reading or revision.
