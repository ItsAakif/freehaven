# Android build and device validation

> **Status: no APK was produced.** The SDK/Gradle work was stopped and all build artifacts, the Android SDK/NDK, the
> Gradle caches and the native `android/` directory were removed at the project owner's request. The findings below are
> kept so the build can be resumed without rediscovering them. No device or emulator run has been performed.

## Environment as found (2026-10-29)

| Requirement | State |
|---|---|
| JDK | **Present** — Temurin 17.0.20.1 (`JAVA_HOME` set) |
| `adb` | **Present** — platform-tools only (`C:\Program Files\platform-tools`) |
| Android SDK | **Missing** — no `ANDROID_HOME`, no `sdkmanager`, no platforms/build-tools |
| Gradle | **Missing** — no global Gradle; project wrapper resolves 9.4.1 |
| Emulator / AVD | **Missing** — no system image, no AVD |
| Connected device | **None** — `adb devices` empty |
| Native project | **None** — Expo-managed, CNG (`android/` did not exist) |
| Workflow | Expo Go / development build; **not** bare React Native |

The project is Expo SDK 58 (React Native 0.88, React 19). `npx expo export` producing a Hermes
bundle proves the **JavaScript** is valid; it says nothing about the native build.

## Setup performed

```powershell
# 1. Command-line tools
#    https://dl.google.com/android/repository/commandlinetools-win-13114758_latest.zip
#    extracted to %LOCALAPPDATA%\Android\Sdk\cmdline-tools\latest

# 2. Licences + packages
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
$env:ANDROID_HOME = $sdk; $env:ANDROID_SDK_ROOT = $sdk
sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"
sdkmanager "platforms;android-37.0" "build-tools;37.0.0" "ndk;27.1.12297006"

# 3. Persist for future shells
[Environment]::SetEnvironmentVariable('ANDROID_HOME', $sdk, 'User')
[Environment]::SetEnvironmentVariable('ANDROID_SDK_ROOT', $sdk, 'User')

# 4. Generate the native project (CNG; never edited by hand)
cd freehaven
npx expo prebuild --platform android --no-install

# 5. Debug APK
cd android
.\gradlew.bat assembleDebug --no-daemon --console=plain
```

Prebuild resolved: `compileSdk 37`, `targetSdk 36`, `minSdk 24`, `ndk 27.1.12297006`,
Kotlin 2.2.10, application id `app.freehaven.mobile`, Gradle 9.4.1.

### Build issues hit (and fixes)

1. **NDK install raced the SDK manager.** Gradle tried to install `ndk;27.1.12297006` while a parallel `sdkmanager`
   job was writing the same directory; Gradle reported `InstallFailedException`. Installing the NDK, platform 37 and
   build-tools 37 explicitly with `sdkmanager` first resolved it.
2. **Windows long-path failure in CMake.** `react-native-worklets` failed for `armeabi-v7a` with
   `ninja: error: mkdir(.../CMakeFiles/worklets.dir/E_/Projects/...)` — the object path exceeds the classic
   260-character limit. Two mitigations were identified: enable `LongPathsEnabled` (needs administrator) or build from
   a short real path with `-PreactNativeArchitectures=arm64-v8a`.
3. **`subst` drive is not a workaround.** Exposing the repo as `X:\` makes `expo-modules-autolinking` fail with
   `Couldn't find "package.json" up from path "X:\"`, because it walks up from the drive root. A **short real path**
   (for example `C:\fh`) is required, not a virtual drive.
4. Gradle auto-installed CMake 3.22.1 during the build; that is expected for `expo-sqlite`.

The build was stopped while running from a short-path clean copy; no `app-debug.apk` was produced. The remaining
blockers are the Windows path workaround (documented above) and the absence of a device/emulator.

### If the SDK is ever missing again

1. Install JDK 17 (Expo SDK 58 does not support JDK 21+ reliably).
2. Download the command-line tools zip above; extract so that
   `%LOCALAPPDATA%\Android\Sdk\cmdline-tools\latest\bin\sdkmanager.bat` exists.
3. Run the four `sdkmanager` commands above (accept licences).
4. Set `ANDROID_HOME`/`ANDROID_SDK_ROOT`.
5. `npx expo prebuild --platform android` then `gradlew assembleDebug`.

No dependency versions were changed for the build.

## Building without a device

```powershell
cd freehaven\android
$env:ANDROID_HOME="$env:LOCALAPPDATA\Android\Sdk"
.\gradlew.bat assembleDebug
# output: android\app\build\outputs\apk\debug\app-debug.apk
```

## Installing on a physical device

```powershell
adb devices                  # must list the phone; enable USB debugging
adb install -r app-debug.apk
adb shell am start -n app.freehaven.mobile/.MainActivity
adb logcat -s ReactNativeJS:V ExpoModulesCore:V AndroidRuntime:E > freehaven-logcat.txt
```

If the device is not listed: install the OEM USB driver, enable "USB debugging" and accept the
RSA prompt. Wireless debugging (`adb pair`) works on Android 11+.

## Device validation results

**No device or emulator was available, so no runtime row below was executed.** This table is
the checklist for the first session; every result must be recorded with the device model, Android
version and log excerpts.

| # | Check | Steps | Expected | Result |
|---|---|---|---|---|
| 1 | Fresh install & cold start | uninstall, `adb install`, first launch | splash → onboarding within 3 s; no crash | not run |
| 2 | DB init & migration | launch, then upgrade from a v1/v2 build | schema v3; no data loss; no "newer database" error | not run |
| 3 | Gutenberg discovery | Discover → Philosophy; tap a book | results load; cover + details; attribution shown | not run |
| 4 | EPUB import & reading | Download & read; wait for index | chapters, TOC, progress; text selectable | not run |
| 5 | PDF import & fallback | Import a text PDF and a scanned PDF | text pages readable; scan rejected with OCR message; original opens | not run |
| 6 | Highlights, notes, bookmarks | select text; add note; bookmark with folder/tag | persisted; visible in Mindspace; jump-back works | not run |
| 7 | Cards & FSRS | Build cards; review with all four grades | intervals previewed and persisted; due dates update | not run |
| 8 | Position persistence | read 3 sections, kill app, relaunch | resumes at saved section/scroll | not run |
| 9 | TTS & interruptions | Listen; lock screen; take a call | speech pauses/resumes; lock-screen transport (studio mode) works | not run |
| 10 | Kill/relaunch recovery | force stop during narration | position and queue restored | not run |
| 11 | Offline | airplane mode: read, highlight, review, listen | all local features work; catalogue shows offline copy | not run |
| 12 | Export & delete | Export JSON; delete all data | share sheet opens; library emptied; schema intact | not run |

### Environment-level blockers

- **Hardware virtualization is disabled** (`Win32_Processor.VirtualizationFirmwareEnabled = False`), so an Android
  emulator would either fail to start or run without acceleration. Enabling VT-x/AMD-V in the BIOS/UEFI is a physical
  intervention I cannot perform from here. This is the only remaining blocker to a device session besides having a
  phone.
- No emulator image or AVD is installed.
- No physical device is connected.
- Background TTS behaviour and lock-screen controls depend on a development/release build, not Expo Go.
