# Servify for Android

A small companion app for your own Servify: see what's running, read live logs and restart,
redeploy, stop or start services from your phone. It's a [Capacitor](https://capacitorjs.com)
app: a React UI (sharing Servify's types, icons and design tokens with the dashboard) inside a
native Android shell.

## Signing in

1. Enter the address you open the dashboard with, such as `192.168.1.20:7700` at home or your VPN
   address away from home. The app checks that it's a Servify and shows its version.
2. Enter the owner password and a name for the phone.

The phone gets its own **device token** (`POST /api/auth/device`), which acts as the owner. You
can sign it out from the app, or from the dashboard under **Settings → Security → Signed-in devices**.
A revoked phone goes back to the sign-in screen with the address filled in. Several servers can be
added, and you switch between them in the app's Settings.

- The token is encrypted with an AES-256-GCM key in the Android Keystore
  (`SecureStorePlugin.java`). It's left out of cloud backups and device-to-device transfers.
- Plain `http://` is only accepted for local and VPN addresses (private IP ranges, Tailscale's
  `100.64.0.0/10`, `.local`/`.lan`/`.ts.net` names, single-label hostnames). Public addresses need
  `https://`.
- Servify answers on bare IP addresses. If you use a hostname (e.g. a Tailscale MagicDNS name),
  add it to `SERVIFY_ALLOWED_HOSTS`, or the app shows "Servify refused the address …".
- Needs a Servify with phone sign-in (this repository after 0.2.1). Older ones are detected and
  the app asks you to update.

Push alerts aren't built in: add an ntfy channel in Servify (Settings → Notifications) and use
the ntfy app.

## Building

Requirements: Node 22+, JDK 21 and the Android SDK (platform 36, build-tools 36). On macOS:

```bash
brew install openjdk@21
brew install --cask android-commandlinetools
```

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=$HOME/Library/Android/sdk
sdkmanager --sdk_root=$ANDROID_HOME "platforms;android-36" "build-tools;36.0.0" "platform-tools"
```

```bash
cd mobile
npm install
npm run apk          # → android/app/build/outputs/apk/release/app-release.apk
```

`npm run sync` builds the web part and copies it into the Android project (then
`cd android && ./gradlew assembleDebug` for a debug build). The version comes from
`package.json` (`0.1.0` → versionName `0.1.0`, versionCode `100`). Raise it for every release
so phones accept the update.

### Release signing

Release builds are signed with the key described in `~/.android/servify-release.properties`
(or the file named by `SERVIFY_RELEASE_PROPS`):

```properties
storeFile=/Users/you/.android/servify-release.jks
storePassword=…
keyAlias=servify
keyPassword=…
```

Without that file the release APK is unsigned. **Back up the keystore and its properties file.**
Android only installs an update over an existing app when it's signed with the same key, so
losing the key means uninstalling the app (and signing in again) to install a new build.

## Development

`npm run dev` serves the UI on port 5180 for quick layout work in a browser. Servify only
allows CORS from the app's own origins (`http://localhost`, `https://localhost`,
`capacitor://localhost`), so talk to a real server from the emulator or a phone. The Android
emulator reaches your computer at `10.0.2.2`.
