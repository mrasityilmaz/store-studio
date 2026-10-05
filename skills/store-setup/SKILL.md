---
name: store-setup
description: Walks the user through creating an App Store Connect API key and a Google Play service account and connecting them to store-studio. Use when the user wants to set up store-studio, when setup_check reports a store as not configured, or when a store tool fails with a 401/403, sign-in or permission error.
---

# Set up store-studio

store-studio talks to the stores with credentials the user creates in their own
accounts. The keys stay on the user's machine: the plugin only reads the files
to sign short-lived tokens.

Ground rules while helping:

- Never ask the user to paste a key, private key or JSON contents into the chat.
  Only file paths and the two App Store IDs are needed.
- Key files belong outside every git repository. `account_add` takes care of
  that: it moves them to `~/.appstoreconnect/` and `~/.config/store-studio/play/`,
  readable only by the user.
- The user only needs the store they publish to. Either half can stay empty.

Start with `setup_check` to see what is already configured, then walk through
only the missing part.

## App Store Connect API key

The Account Holder or an Admin does this once per team.

1. In App Store Connect open **Users and Access > Integrations > App Store Connect API**.
   The first time, the Account Holder has to request API access there.
2. Under **Team Keys**, generate a key. Give it the **App Manager** role, which
   covers listings, screenshots, versions, builds and TestFlight. Admin also
   works but grants more than needed. Sales and finance reports are limited to
   the Admin, Finance and Sales roles: if the user wants them, add a second key
   with the Finance role as its own account (e.g. `acme-finance`) and pass that
   account for report calls.
3. Download the `.p8` file right away. Apple only offers the download once.
4. Note the **Key ID** from the keys table and the **Issuer ID** shown above it.

## Google Play service account

1. In Google Cloud Console, choose or create a project and enable the
   **Google Play Android Developer API** (APIs & Services > Library).
2. Open **IAM & Admin > Service Accounts**, create a service account (it needs
   no Cloud roles), then **Keys > Add key > JSON** and download the file.
   If key creation is blocked, an organization policy
   (`iam.disableServiceAccountKeyCreation`) is in the way and a Cloud admin must allow it.
3. In Play Console open **Users and permissions > Invite new users**, enter the
   service account's email (`...@....iam.gserviceaccount.com`), add the app under
   **App permissions**, and grant the store presence permission that lets it edit
   the store listing. A new invitation can take a while to start working.

## Connect them to the plugin

Don't ask the user to move files or edit JSON. Use `account_add`:

- App Store: `account_add` with `store: app_store`, a short `name` (the team, e.g.
  `acme`), `key_file` (the downloaded `AuthKey_XXXX.p8`, usually in `~/Downloads`)
  and `issuer_id`. The Key ID comes from the file name.
- Google Play: `account_add` with `store: google_play`, `name`, `key_file` (the
  service account JSON) and optionally `package` to test access.

It moves a key out of Downloads into a private folder (keys already in a hidden
folder such as `~/.appstoreconnect` stay put), restricts it to the user, records
it in `~/.config/store-studio/accounts.json` and tests it. If the test fails,
fix the input and run it again with `replace: true`. `account_remove` takes an
account out again. Every team or developer account is one more `account_add`;
tools pick the right account per app.

The plugin options (`/plugin` → store-studio) can hold one account instead; they
show up as the account named `default`.

## Common errors

| Error | Cause |
| - | - |
| "store-studio needs Node.js 22 or newer", or no store-studio tools | Node.js is missing or too old; install a current one from nodejs.org and restart Claude Code |
| App Store 401 | Wrong Key ID or Issuer ID, a revoked key, or a `.p8` from another team |
| App Store 403 | The key's role is too low: App Manager for listing work; Admin, Finance or Sales for sales and finance reports |
| Google sign-in failed: invalid_grant | The JSON key was deleted in Cloud Console, or the machine clock is off |
| Play 403 "caller does not have permission" | Service account not invited in Play Console, no access to this app, or the API is not enabled in its Cloud project |
| Play 404 on the package | Typo in the package name, or the app was never uploaded to Play Console |
