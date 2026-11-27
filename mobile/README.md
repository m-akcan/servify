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
  (`SecureStorePlugin.java`). It's left out of cloud backups and device-to-device transfers. With
  the app lock on (below), that key only works right after you unlock.
- Plain `http://` is only accepted for local and VPN addresses (private IP ranges, Tailscale's
  `100.64.0.0/10`, `.local`/`.lan`/`.ts.net` names, single-label hostnames). Public addresses need
  `https://`.
- Servify answers on bare IP addresses. If you use a hostname (e.g. a Tailscale MagicDNS name),
  add it to `SERVIFY_ALLOWED_HOSTS`, or the app shows "Servify refused the address …".
- Needs a Servify with phone sign-in (this repository after 0.2.1). Older ones are detected and
  the app asks you to update.

## HTTPS with Servify's own certificate

Servify's HTTPS router can serve certificates from its own local CA (Settings → HTTPS). No phone
trusts that CA, so the app lets you trust it **for one server at a time**:

1. Enter the `https://` address. Before sending anything, the app opens a TLS connection only to
   look at the certificate (`ServerTrustPlugin.inspect`, which always aborts the handshake).
2. If no public CA issued it, the app shows the CA's name and **SHA-256 fingerprint** (taken from
   the certificate chain the server sent). Compare it with your Servify's local CA: download it in
   the dashboard under Settings → HTTPS → Local CA and run
   `openssl x509 -noout -fingerprint -sha256 -in servify-local-ca.pem`.
3. "They match, trust it" pins that CA for exactly that host and port.

From then on, a certificate Android doesn't trust is accepted for that server only if
(`ServerTrust.verify`):

- it was signed directly by the pinned CA (Servify's leaves are; chains with an intermediate CA
  aren't supported),
- it and the CA are within their validity period, it isn't itself a CA, and it's meant for TLS
  servers, and
- its subjectAltName names the host in the address (IP addresses against IP entries, names
  against DNS entries, one leftmost `*.` wildcard). The CN is ignored.

Anything else is refused, as before: there's no "trust all" path, and a pin never applies to
another host or port. Every request of the app (API calls and the live event stream, all
`fetch()` in the WebView) goes through one `WebViewClient.onReceivedSslError`
(`PinningWebViewClient.java`), so this covers all of them. Removing the server removes its pin.
If a pinned server later shows a different certificate, the app refuses to connect and offers to
check the new one (with a warning) before you sign in again.

What this is and isn't:

- The pin is an *extra* trust anchor for that server, not exclusive pinning. A certificate that
  Android already trusts (a public CA, or one you installed in Android's settings) is accepted as
  usual; the WebView only asks the app when its own checks fail.
- The hostname check means you need an address the certificate names. Servify issues local-CA
  certificates for the domains routed to it, so route a domain to the dashboard (for example an
  external route to the dashboard's port with a `.lan` or `.home.arpa` domain, plus
  `SERVIFY_ALLOWED_HOSTS`) and use `https://<that domain>`. An IP address over https doesn't
  work with Servify's router: TLS clients send no server name for IPs, and Servify then answers
  with its `localhost` certificate.

## App lock

The device token acts as the owner, so the app can lock itself (Settings → App lock):

- It asks for a fingerprint or secure face unlock (Android's "strong" biometrics) **or** the
  phone's PIN, pattern or password (BiometricPrompt with `DEVICE_CREDENTIAL`), when the app opens
  and when it comes back after **1 minute** in the background. "Right away", 5 and 15 minutes
  can be picked instead. One minute keeps a quick switch to another app (copying a log line, a 2FA
  code) painless while a phone left on a table locks soon.
- While locked, nothing that holds the token is mounted, and the app's screen is covered in the
  recent-apps view.
- With the lock on, the token is re-encrypted with a second Keystore key that requires user
  authentication and is only usable for 30 seconds after you authenticate. So the token can't be
  read from storage while the phone is locked or long after its last unlock. Note that Android
  counts unlocking the phone itself as an authentication, so the key works for those 30 seconds
  after the phone is unlocked too; the app's own prompt is what keeps someone holding an unlocked
  phone out, and it is enforced in the app's native code. Adding a fingerprint doesn't affect it; **removing the screen
  lock destroys that key**: the app then turns the lock off, says why, and asks you to sign in
  again (the old device stays listed in the dashboard until you remove it there).
- It's off until you turn it on. After this update (and after a first sign-in) the app offers
  it once. A phone without a screen lock can't use it; the app explains that and links to
  Android's security settings.

## Updates

The app updates from your own Servify, not from a store or a download site. Each Servify
mirrors the APK from its signed GitHub release (the release of the version it runs) and serves
it at `GET /api/mobile/app.apk`. See "App updates from your own Servify" in the main README.

- **When it asks.** When the app opens and when it comes back from the background, at most
  every 6 hours per server (`GET /api/mobile/app`). **Settings → Check for updates** asks right
  away. If the offered `versionCode` is higher than the app's own, a banner says *Update
  available: X.Y.Z*. **×** hides it for that version. Servify servers without the mirror (0.2.3
  and older) aren't asked.
- **Downloading** (`AppUpdatePlugin.java`) happens natively, into the app's private cache, with
  the device token. TLS is decided like the WebView's: the system's trust first, then only the
  CA pinned for exactly that host and port (`ServerTrust.verify`). There's no "trust all", and
  redirects aren't followed, so the token never goes anywhere else. Progress shows in the banner.
- **Before Android's installer opens**, the download must:
  - match the size and SHA-256 the server announced;
  - be `cloud.servify.app`;
  - have a higher versionCode than the installed app, the same one the server announced;
  - be signed with **the same certificate(s) as the installed app** (`getPackageArchiveInfo`
    with `GET_SIGNING_CERTIFICATES`, compared with the installed package; `GET_SIGNATURES`
    below Android 9). If Android can't tell who signed it, it is refused.

  Anything else is deleted, and the banner says why, e.g. *The download isn't signed with the
  same key as this app, so it was not installed.*
- **Installing** uses `PackageInstaller`. The checked file is hashed again as it is written into
  the install session, and Android shows its own *Do you want to update this app?*. The app
  restarts as the new version and stays signed in (same signing key, so its data and Keystore
  keys stay).
- **"Install unknown apps".** The app needs `REQUEST_INSTALL_PACKAGES`. The first time, it
  explains why and opens Android's *Install unknown apps* page for Servify. Turn on *Allow from
  this source*, come back, and tap Update again.
- **App lock.** The banner is only there while the app is unlocked, and the native side refuses
  to download or install while it is locked.
- **Version header.** Every API request carries `X-Servify-App: <versionName>/<versionCode>`.
  Servify stores it on the phone's device token, and the dashboard shows each phone's app
  version and *update available* under Settings → Security → Signed-in devices. It is only sent
  to a Servify whose `/auth/status` lists the `app-version-header` feature, because older ones
  would refuse it in their CORS preflight.

### Releasing a new app version

1. Raise `version` in `mobile/package.json` (versionCode = major·10000 + minor·100 + patch;
   it must be higher than the app in the previous release).
2. `npm run apk` (release-signed, see below).
3. Publish the Servify release with
   `node scripts/publish-release.mjs vX.Y.Z --apk mobile/android/app/build/outputs/apk/release/app-release.apk`.
   It refuses an APK that isn't signed by the pinned release certificate
   (`ANDROID_SIGNER_SHA256` in `server/src/releasekey.ts`) or isn't newer than the last one. A
   Servify release without an app change uses `--no-apk`, and servers keep serving the app they have.

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
`package.json` (`0.2.0` → versionName `0.2.0`, versionCode `200`: major·10000 + minor·100 + patch). Raise it for every app release
so phones accept the update (and `publish-release` accepts the APK).

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
