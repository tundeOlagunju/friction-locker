# Friction Vault

Friction Vault is a local-first Screen Time PIN and recovery-credential keeper.
It generates a random four-digit PIN, guides you through entering it in iPhone
Settings without showing the completed PIN, and puts a deliberate counting
challenge in front of later retrieval.

There is no account, API, database, analytics service, or PIN upload. A static
host only delivers the app files. PIN generation, credential sealing,
encryption, storage, backup opening, challenge progress, and decryption run in
the browser.

## What it does

- Generates a non-obvious four-digit PIN with the Web Crypto API.
- Gives one `Enter digit` or `Delete` instruction at a time while you switch
  between the app and iPhone Settings.
- Uses an independent instruction sequence for Screen Time's confirmation step.
- Stores the sealed record in IndexedDB on the current device.
- Stores separate Screen Time recovery email and Apple ID credentials behind
  the same challenge.
- Requires five randomized 50-digit counting grids per configured minute before
  revealing a sealed item.
- Exports a self-contained `.friction-vault` recovery file.
- Opens a backup for temporary retrieval without restoring it, or merges it into
  the device vault.
- Installs as a PWA and caches its application shell for offline use.

## Run it locally

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. Browser storage belongs to that origin, so a vault
created on localhost is separate from one created on GitHub Pages.

Useful checks:

```bash
npm run lint
npm test
npm run build:static
```

The last command writes a serverless static export to `out/`.

## Put it on an iPhone

An iPhone needs to load the app once from an HTTPS address before it can install
and work offline. GitHub Pages can provide that static address; it does not
receive the vault or PIN.

1. Push this folder to a GitHub repository.
2. In the repository, open **Settings → Pages** and choose **GitHub Actions** as
   the source.
3. Run the **Deploy Friction Vault to Pages** workflow manually.
4. Open the resulting Pages URL in Safari on the iPhone.
5. Use Safari's Share menu, choose **Add to Home Screen**, enable **Open as Web
   App**, and tap **Add**.
6. Launch the installed app once while online so its offline shell is cached.

The included workflow reads GitHub Pages' actual base path, so repository sites
and custom domains both build correctly.

## Recovery after losing a phone

Keep a current exported backup somewhere separate, such as iCloud Drive. On a
replacement iPhone, reinstall Friction Vault from its static URL, choose **Open a
backup**, and either retrieve directly from the file or merge it into the new
device's vault.

Export again whenever you add or delete a record. Removing the PWA, clearing its
website data, or losing the device can erase the IndexedDB copy.

## Security boundary

This is behavioural friction, not protection from an attacker or a determined
technical owner.

Records use AES-256-GCM with per-record random material and authenticated
metadata. That prevents casual reading and detects accidental or malicious file
changes. The recovery file must work without a memorable password, however, so
it necessarily carries everything the app needs to derive its keys. Someone who
has both the backup and the source code can bypass the challenge.

That trade-off is intentional: no company or second person holds your PIN or
recovery Apple ID credentials, recovery does not depend on remembering another
secret, and the normal interface still creates a meaningful pause during an
impulsive moment.

Do not use this as a general password manager or as the sole protection for
high-value secrets.

## Project shape

- `app/page.tsx` — PIN setup, recovery credentials, retrieval, backup, and boundary UI.
- `lib/challenges.ts` — secure PIN generation and randomized challenges.
- `lib/vault.ts` — IndexedDB persistence, encryption, and backup validation.
- `public/sw.js` — offline application-shell cache; it never handles vault data.
- `public/manifest.webmanifest` — install metadata and icons.
