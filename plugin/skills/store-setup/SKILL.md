---
name: store-setup
description: Walks the user through creating an App Store Connect API key and a Google Play service account and entering them in store-studio's plugin settings. Use when the user wants to set up store-studio, when setup_check reports a store as not configured, or when a store tool fails with a 401/403, sign-in or permission error.
---

# Set up store-studio

store-studio talks to the stores with credentials the user creates in their own
accounts. The user enters them in the plugin settings, which keep the key
contents in the system's secure storage (the Keychain on a Mac). The plugin
never reads key files from disk.

Ground rules while helping:

- Never ask the user to paste a key, private key or JSON contents into the chat,
  and never read or print a key file yourself. Key contents only go into the
  settings dialog.
- The user only needs the store they publish to. Either half can stay empty.
- There are three account slots per store, for users with several App Store
  Connect teams or Play developer accounts.

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
   with the Finance role in the next free slot (for example named `acme-finance`)
   and use that account for report calls.
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

## Enter them in the plugin settings

Tell the user to:

1. In Claude Code in a terminal (`claude`), run `/plugin`, go to the
   **Installed** tab, open **store-studio** and choose **Configure options**.
   The settings are shared with the desktop app and IDE extensions.
2. App Store Connect: fill in **key ID** and **issuer ID**. Then open the
   downloaded `AuthKey_XXXXXXXXXX.p8` in a text editor, select all, copy, and
   paste it into **private key**, including the BEGIN and END lines.
3. Google Play: open the service account `.json` file the same way and paste
   all of it into **service account key**.
4. Optionally give each account a short **name** (for example `acme`). Unnamed
   accounts are called `app-store` and `google-play`, with the slot number after
   the first.
5. Save, then restart Claude Code (or run `/reload-plugins`) so the server picks
   up the settings, and run `setup_check` again.

Once the settings are saved, the downloaded key files aren't needed by the
plugin anymore. Suggest keeping them somewhere safe outside every git repository,
or deleting them.

Users who set up accounts with store-studio 0.5 or earlier (`account_add` and
`~/.config/store-studio/accounts.json`) enter each account once in the settings
as above. The old files are no longer read.

## Common errors

| Error | Cause |
| - | - |
| "store-studio needs Node.js 22 or newer", or no store-studio tools | Node.js is missing or too old; install a current one from nodejs.org and restart Claude Code |
| "isn't set up" | No account in the settings yet, or Claude Code wasn't restarted after saving them |
| "holds a file path" | An old setting holds the key's path; paste the file's contents instead |
| "isn't a private key" / "isn't valid JSON" | Only part of the file was pasted; paste the whole file again |
| App Store 401 | Wrong Key ID or Issuer ID, a revoked key, or a `.p8` from another team |
| App Store 403 | The key's role is too low: App Manager for listing work; Admin, Finance or Sales for sales and finance reports |
| Google sign-in failed: invalid_grant | The JSON key was deleted in Cloud Console, or the machine clock is off |
| Play 403 "caller does not have permission" | Service account not invited in Play Console, no access to this app, or the API is not enabled in its Cloud project |
| Play 404 on the package | Typo in the package name, or the app was never uploaded to Play Console |
