# MultAI Companion for Android

[Download signed APK 0.1.5](https://app.multai.si/app/android) · [Use the browser companion](https://app.multai.si/)

The Android app is a Capacitor 8 shell around the shared companion screens (`packages/companion-ui`). What it does and how pairing works: [docs/mobile-companion.md](../../docs/mobile-companion.md).

| | |
|---|---|
| Application id | `si.multai.companion` (stable; test builds are `si.multai.companion.test`) |
| Version | `version.properties` (`versionName`, `versionCode`) |
| Service | `https://api.multai.si` only (release); its CSP allows no other origin |
| Android | 10 (API 29) or newer; target API 36 |
| Signing | APK Signature Scheme v3, RSA 4096, key outside Git |
| Release APK | `release/multai-companion-<version>.apk`, with `.sha256` and a provenance `.json` (commit, hashes, certificate) |

Signing certificate SHA-256: `72:E3:60:27:AE:1C:6C:A8:F9:75:A3:F8:95:EA:11:A6:78:84:80:FF:0C:19:B9:C9:F1:3F:1C:E7:7F:F3:7B:7B`

## Install, update, uninstall

Install (sideload; this app is not on Google Play):

1. Download the APK to the phone, or copy it over USB.
2. Check its SHA-256 against `release/<file>.sha256` (on a computer: `shasum -a 256 multai-companion-0.1.5.apk`).
3. Open it and allow your browser or file manager to **install unknown apps** when Android asks. Android shows **MultAI Companion**.

From a computer with USB debugging:

```bash
adb install apps/mobile/release/multai-companion-0.1.5.apk
```

Check the signature before installing:

```bash
apksigner verify --print-certs apps/mobile/release/multai-companion-0.1.5.apk
```

**Update**: install the newer APK over the old one (`adb install -r …`, or open it on the phone). Your sign-in and pairing stay. Android accepts the update only if it is signed with the same key and has a higher `versionCode`; it refuses a downgrade.

**Uninstall**: long-press the icon → *Uninstall*, or `adb uninstall si.multai.companion`. This deletes the app's Keystore key and all its data on the phone. Also remove the phone in the desktop's **Settings → Paired phones** (uninstalling cannot tell the desktop).

## Build

Needs Node 24, JDK 21 and the Android SDK (platform 36, build-tools 36.0.0). With Homebrew:

```bash
brew install openjdk@21 && brew install --cask android-commandlinetools
```

```bash
sdkmanager "platforms;android-36" "build-tools;36.0.0" "platform-tools"
```

Create the private release key once. It goes to `~/.multai/android` (mode 700/600), never into the repository; back it up, because updates need the same key:

```bash
apps/mobile/scripts/create-signing-key.sh
```

Build the signed release APK (web assets, Capacitor sync, Gradle, signature check, SHA-256 and provenance):

```bash
JAVA_HOME=$(brew --prefix openjdk@21) ANDROID_HOME=$(brew --prefix)/share/android-commandlinetools npm run android:release --workspace @multai/mobile
```

The release build stops if the key is missing, never signs with a throwaway key, and takes its version only from `version.properties`. Release builds require committed source and record its exact Git SHA. The script verifies the packaged app ID/version, release debugging flag and APK signature before writing the SHA-256 and provenance files. Keep the same private signing key for every update.

A test build (`si.multai.companion.test`, debug key, WebView inspection on, talks to `http://localhost:4319` through `adb reverse`):

```bash
JAVA_HOME=$(brew --prefix openjdk@21) ANDROID_HOME=$(brew --prefix)/share/android-commandlinetools npm run android:test --workspace @multai/mobile
```

## How it keeps secrets

- The sign-in refresh token, device proof and owner credential are encrypted by `SecureStorePlugin` with an AES-256-GCM key that lives in the Android Keystore and never leaves it. App backup and device transfer are disabled.
- Pending Google sign-in and invitation return state also use Keystore-backed storage, with the PKCE verifier flushed before opening Google. Older plaintext pending flows are discarded on update; if an update interrupts sign-in, start sign-in again.
- Owner signing and preview keys are non-extractable WebCrypto keys.
- Release builds allow HTTPS only, with system certificate authorities; WebView debugging is off.
- Google sign-in opens a Custom Tab and comes back on `multai-companion://auth/callback` with the one-time code in the fragment, bound to a PKCE verifier.
- Invitation, pairing and review links (`https://api.multai.si/app/#join=…`, `#pair=…`, `#review=…`) open the app once the service publishes `/.well-known/assetlinks.json` with the certificate above; otherwise they open the browser companion without requiring an app download. Only the exact `/app` and `/app/` paths and this build’s sign-in callback scheme are accepted. A pending invitation survives sign-in, reload and Android process death for up to 15 minutes; joining still requires confirmation and host admission.

## Emulator test

`test/android-e2e.ts` installs the test APK on a running emulator and drives it with Playwright's Android WebView driver against a local service and the desktop's real `RemoteControlHost`. It is an emulator run, not a phone.

```bash
TEST_DATABASE_URL=postgresql://… ANDROID_HOME=… node --import tsx apps/mobile/test/android-e2e.ts apps/mobile/build-test/multai-companion-test-0.1.5-1.apk apps/mobile/build-test/multai-companion-test-0.1.5-2.apk
```

The two test APKs must use ascending version codes. Build them with `MULTAI_TEST_VERSION_CODE=1` and then `2` (or set `MULTAI_E2E_FIRST_VERSION` / `MULTAI_E2E_SECOND_VERSION` to the chosen codes). The suite also checks HTTPS-invitation entry and restoration after Android process death.

Run the native manifest/security checks on the connected emulator after building a test APK:

```bash
cd apps/mobile/android
JAVA_HOME=/opt/homebrew/opt/openjdk@21 ANDROID_HOME=/opt/homebrew/share/android-commandlinetools ./gradlew :app:connectedDebugAndroidTest
```

Real Google consent and a physical Android phone require a separate live acceptance check; the automated owner-control suite uses synthetic identities and a synthetic desktop agent.
