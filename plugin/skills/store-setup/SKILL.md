---
name: store-setup
description: Walks the user through creating an App Store Connect API key and a Google Play service account and connecting them to store-studio, in the chat with account_add or in the plugin settings. Use when the user wants to set up store-studio or connect a store account, when setup_check reports a store as not set up, or when a store tool fails with a 401/403, sign-in or permission error.
---

# Set up store-studio

store-studio talks to the stores with credentials the user creates in their own
accounts. There are two ways to connect them:

- **In the chat (the default, works in every Claude Code app):** the user gives
  the downloaded key file's path, and `account_add` records it.
- **In the plugin settings:** up to two accounts per store, entered in a
  terminal. The Claude desktop app has no settings screen.

Ground rules while helping:

- Never ask the user to paste a key, private key or JSON contents into the chat,
  and never read, open or print a key file yourself. `account_add` opens it
  only after the user confirms its plan; after that the plugin reads it only to
  sign in.
- Only paths and IDs go into the chat. The Key ID and Issuer ID aren't secret.
- The user only needs the store they publish to. Either half can stay empty.

Start with `setup_check` to see what is already connected, then walk through
only the missing part.

## App Store Connect API key

The Account Holder or an Admin does this once per team.

1. In App Store Connect open **Users and Access > Integrations > App Store Connect API**.
   The first time, the Account Holder has to request API access there.
2. Under **Team Keys**, generate a key. Give it the **App Manager** role, which
   covers listings, screenshots, versions, builds and TestFlight. Admin also
   works but grants more than needed. Sales and finance reports are limited to
   the Admin, Finance and Sales roles: if the user wants them, create a second
   key with the Finance role, connect it as its own account (for example
   `acme-finance`) and use that account for report calls.
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

## Connect them in the chat

1. Ask for the downloaded file's path (it is usually in `~/Downloads`) and, for
   App Store Connect, the Issuer ID. The Key ID comes from the
   `AuthKey_<KEYID>.p8` file name. Suggest a short account name (the team or
   company, e.g. `acme`).
2. Run `account_add` as a dry run (the default): `store`, `name`, `key_file`,
   and `issuer_id` for App Store Connect. For Play, add `package` to test access
   to an app. Show the plan: which file, where it will move, what gets recorded.
3. After the user confirms, run it again with `dry_run: false`. It checks the
   key, moves it into a private folder (keys already in a hidden folder such as
   `~/.appstoreconnect` stay put; `keep_original` copies instead), records the
   path and IDs in `~/.config/store-studio/accounts.json` and signs in. Report the
   App Store apps it sees, or for Google Play whether the sign-in (and the
   package, if given) works.
4. If the sign-in fails, fix the input and run it again with `replace` set to
   true. `account_remove` disconnects an account; the key file stays.

Accounts connected this way work in the terminal, the desktop app and IDEs at
once, with no restart. Accounts connected with store-studio 0.5 work as they
are; a third settings slot from 0.6 is gone, so connect that account here. The downloaded key must stay where `account_add` put it;
if it moves, connect it again.

## Or enter them in the plugin settings

For users who prefer them: in Claude Code in a terminal (`claude`), `/plugin` >
**Installed** > **store-studio** > **Configure options**. The form keeps only the
first line of a paste, so each key must be entered as one line; that is easy to
get wrong, which is why connecting in the chat is the default. The Claude desktop
app has no settings screen; settings entered in a terminal reach new desktop
sessions, but not a copy of store-studio loaded from a local folder.

## Common errors

| Error | Cause |
| - | - |
| "store-studio needs Node.js 22 or newer", or no store-studio tools | Node.js is missing or too old; install a current one from nodejs.org and restart Claude Code |
| "isn't set up" | No account connected yet: connect it in the chat with `account_add` |
| "only its first line was saved" | The terminal settings form kept one line of a pasted key; connect the account in the chat instead |
| "loaded from a local folder" | Plugin settings don't reach this copy; connect the account in the chat |
| "Can't read the App Store Connect key file" / "Can't read the Google Play service account file" | A connected account's key file moved or was deleted; connect it again with the new path |
| "holds a file path" | A plugin setting holds a path instead of the key; connect the account in the chat instead |
| "isn't a private key" / "isn't valid JSON" (settings) | A setting holds part of a key; connect the account in the chat instead |
| "is not a valid .p8 private key" / "is not valid JSON" / "is not a Google service account key" (account_add) | The file isn't the downloaded key; ask for the `AuthKey_….p8` or the service account `.json` |
| App Store 401 | Wrong Key ID or Issuer ID, a revoked key, or a `.p8` from another team; connect it again with `replace` set to true |
| App Store 403 | The key's role is too low: App Manager for listing work; Admin, Finance or Sales for sales and finance reports |
| Google sign-in failed: invalid_grant | The JSON key was deleted in Cloud Console, or the machine clock is off |
| Play 403 "caller does not have permission" | Service account not invited in Play Console, no access to this app, or the API is not enabled in its Cloud project |
| Play 404 on the package | Typo in the package name, or the app was never uploaded to Play Console |
