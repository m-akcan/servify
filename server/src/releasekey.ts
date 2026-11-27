/**
 * The public keys Servify trusts to sign its own releases (Ed25519, raw 32-byte keys in base64). The updater only
 * installs a release whose manifest is signed by one of these (see releasesig.ts and updater.ts).
 *
 * The private key is on the maintainer's machine only (~/.servify-release/release-key.pem, made with
 * `node scripts/release-key.mjs keygen`), never in this repository, a GitHub secret or CI: a compromised GitHub
 * account, workflow or token can change a release, but can't sign one.
 *
 * Rotating the key (planned, or because the old one is lost or leaked):
 *   1. Create the new key and add its public key here, next to the old one, and release that version signed with
 *      the OLD key — installs only trust what they already have, so this is how they learn the new key.
 *   2. From the next release on, sign with the new key. Releases signed with either key install for one cycle.
 *   3. Remove the old key here in a later release. A leaked key is removed in step 1's release already (sign that
 *      one with the old key as usual — there is no other way to reach existing installs), and anyone who skips it
 *      must update by hand.
 * A lost key with no successor pinned means existing installs can't be updated automatically any more: they get a
 * clear "not signed by a trusted key" message and have to install the next version by hand.
 *
 * People who build and sign their own releases can trust their own key instead with SERVIFY_UPDATE_KEYS (see
 * releasesig.ts) — the built-in list is then ignored.
 */
export type ReleaseKey = { id: string; publicKey: string };

export const RELEASE_KEYS: readonly ReleaseKey[] = [
  // Created 2026-11-27 on the maintainer's Mac.
  { id: '21dece2e032bc1a1', publicKey: 'J2BOYE23LzxvcHn7HTq4JmvOdHTOaReDE+NzSY/Qvbg=' },
];

/**
 * SHA-256 of the certificate the Android app's release builds are signed with (~/.android/servify-release.jks on the
 * maintainer's machine; `apksigner verify --print-certs`). scripts/publish-release.mjs refuses an APK signed with
 * anything else, and Servify only mirrors an app whose signed manifest names this signer (unless SERVIFY_UPDATE_KEYS
 * replaces the built-in release keys: people who sign their own releases sign their own app too). The phone itself
 * checks that an update is signed with the same certificate as the installed app before it opens the installer.
 */
export const ANDROID_SIGNER_SHA256 = '9e0112d1c9db3d8a084ff48f4a12350e0243ba3332eca46e577d47f34219c531';
