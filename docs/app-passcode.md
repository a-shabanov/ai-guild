# App passcode and account sign-in

Passkeys, Google, Telegram and API keys sign into an account. The app passcode protects a saved session on a particular client. It does not replace account sign-in or server-side email/Telegram two-factor confirmation.

After sign-in, create and confirm a six-digit app passcode. The app asks for it again when reopened and after a minute in the background. Enable quick unlock separately in Settings → App protection. The keypad remains available when biometric confirmation is cancelled or fails. Changing the code or the quick-unlock setting requires the current app passcode. Forgotten codes are reset by signing out and signing back in through a linked account method; signing out removes unsent comments from that client.

## Web / PWA

The code protects the current saved browser session. A new primary sign-in establishes a new session and requires code setup again. Existing sessions older than ten minutes must sign in again before setting their first code.

The server stores a salted scrypt hash (N=32768, r=8, p=1). Locked sessions receive HTTP 423 on authenticated API and MCP requests. Five incorrect attempts start a 30-second cooldown; further failures increase it up to five minutes. Attempts persist on the session and cannot be reset by reloading the page.

Quick unlock uses a separate WebAuthn challenge bound to the existing account, session and unlock purpose. It cannot create a login session, unlock another session or switch accounts. The browser chooses biometric or device-code verification; the app does not read or autofill the passcode and cannot require a specific Face ID / Touch ID sensor. Add a passkey under Account sign-in before enabling quick unlock.

An internet connection is required to unlock a PWA session. Private read/attachment caches are cleared when the app locks; queued comments are retained and sent only after unlocking. Lock metadata and confirmation responses are excluded from service-worker caching. Closing a browser or suspending it can prevent the background timer from running; reopening always performs a server lock before any private view is loaded.

## Native iOS

The app code encrypts the session token using AES-GCM and a key derived by PBKDF2-HMAC-SHA256 (310,000 rounds, random 16-byte salt). The sealed token and persistent retry counters live in a device-only, when-unlocked Keychain item. There is no plaintext session copy available without biometric confirmation once the code is configured.

Optional Face ID / Touch ID holds a separate Keychain copy protected by `biometryCurrentSet`. Enrollment changes invalidate that copy, while the app code still works. Enabling or disabling biometrics requires the current app code. Biometric confirmation unlocks the app directly; it never inserts or exposes the digits of the code.

Existing unprotected sessions move to code setup. Existing biometric-only sessions first require their previous biometric confirmation and then code setup. Background inbox polling cannot decrypt the token once an app code is configured; APNs remains the notification mechanism for protected sessions.

## Local verification

- Server: `cd server && node --test test/app-lock.test.ts test/devices.test.ts test/two-factor.test.ts` (disposable local PostgreSQL databases).
- Native crypto: copy `ios/tests/AppPasscodeTests.swift` to a temporary `main.swift`, compile it together with `ios/AITracker/Platform/AppPasscode.swift`, and run the binary. The Keychain is an in-memory test double.
- Local interface QA: `cd server && node scripts/app-lock-preview.ts`, then open `http://127.0.0.1:4618/api/auth/__preview/setup` or `/api/auth/__preview/biometric`. It uses the separate `aitracker_app_lock_preview` database and disposable accounts.
- Build the simulator app with local signing enabled to test Keychain access. An unsigned simulator build can compile but cannot store Keychain items. Debug-only `AITRACKER_PASSCODE_PREVIEW` accepts `setup`, `locked` or `biometric`; optional `AITRACKER_PREVIEW_SERVER` and `AITRACKER_PREVIEW_TOKEN` select a disposable server session.

## Settings navigation and updates

Settings is a short menu in both clients. Open **Settings → App protection → PIN** to set or change the device PIN; quick unlock is alongside it. Passkeys, linked providers and two-step account login are in **Sign-in methods**. Devices, notifications, appearance and app information each have their own screen. Native also has a participants screen. Only the selected web/native subsection loads its remote settings. First sign-in still requires initial PIN setup.

The clients compare their bundled release version/build with fresh server config on opening and returning to the app. Web also checks every five minutes while visible. A newer release marks Settings/About; web shows a notice once per detected release and an Update button in About. Offline/error checks remain explicit and never claim the client is current. Native shows the newer repository release and asks users to install from their original source; native binary distribution/TestFlight is not configured by this change. Server/web/iOS currently share the repository release version/build.
