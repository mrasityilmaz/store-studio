# store-studio

Manage your App Store and Google Play presence from Claude Code. store-studio
checks, uploads, reorders and downloads screenshots for every locale and device,
edits store text (name, subtitle, description, keywords, promotional text, release
notes, Play title and descriptions), and teaches Claude how to design screenshot
sets that meet both stores' rules on the first upload.

Beyond listings, it reaches every endpoint of both official APIs: Claude looks up
Apple's OpenAPI reference and Google's discovery document, reads what it needs and
proposes changes you confirm. That covers shipping a version (build, age rating,
encryption, review submission, phased release), customer reviews and replies,
analytics, sales and finance reports, pricing, in-app purchases and subscriptions,
custom product pages, experiments, TestFlight, Play tracks and staged rollouts, and
the Play Data safety form.

It talks to the official App Store Connect API and Google Play Developer API with
credentials you create in your own accounts. There is nothing to install besides
Node.js: no fastlane, no Ruby, no npm packages.

## Quick start

1. Install the plugin ([Install](#install)).
2. Create an App Store Connect API key, a Google Play service account, or both,
   and download the key file ([Set up](#set-up) shows where to click).
3. Tell Claude: *"Connect my App Store account, the key is in
   ~/Downloads/AuthKey_ABC123.p8, issuer ID …"* (or *"Connect my Google Play
   account"* with the `.json` file). Claude shows what it will do, and after you
   say yes the account is ready, in every Claude Code app.
4. Ask for what you need, for example *"Show my App Store subtitle and keywords
   for every language."*

Claude always shows you what a change will do first. Nothing changes in a store
until you say yes in the chat.

## What you can ask

- "Check my screenshots in `export/` against App Store and Play rules."
- "Upload the Turkish and German iPhone and iPad screenshots to version 1.4."
- "Replace the Play phone and tablet screenshots for all languages."
- "Show me the current App Store subtitle and keywords for every locale."
- "Update the what's new text for en-US, de-DE and tr."
- "Download the live Play screenshots so we can redesign them."
- "Design a 7-frame screenshot set for 10 languages, phone and tablet."
- "Attach build 57 to version 1.4, set phased release and submit it for review."
- "Add build 57 to the External Testers TestFlight group."
- "Show this week's 1 and 2 star reviews on both stores and draft replies."
- "Pull last month's App Store engagement analytics and tell me where installs come from."
- "Move the Play production rollout from 10% to 50%."
- "Upload build/app/outputs/bundle/release/app-release.aab to production at 20% with these release notes."

## Requirements

- Claude Code (the store tools run as a local MCP server on your machine)
- Node.js 22 or newer on your `PATH` (`node --version` shows yours; get it at [nodejs.org](https://nodejs.org))
- An App Store Connect team API key, a Google Play service account, or both

## Install

Once store-studio is listed in Anthropic's plugin directory, add it from the
directory on claude.ai and it loads in Claude Code as well.

Or install straight from this repository:

```
/plugin marketplace add mrasityilmaz/store-studio
/plugin install store-studio@store-studio
```

### Updating

```
claude plugin marketplace update store-studio
claude plugin update store-studio@store-studio
```

Then restart Claude Code so the new version starts.

## Set up

1. **App Store Connect:** in Users and Access → Integrations → App Store Connect
   API (the first time, the Account Holder has to request access there), create
   a Team Key with the **App Manager** role and download the `.p8` (Apple lets
   you download it only once). Note the **Key ID** and the **Issuer ID** shown
   above the keys list. App Manager covers listings, screenshots, versions,
   builds and TestFlight. Sales and finance reports are limited to the Admin,
   Finance and Sales roles; if you want those, create a second key with the
   Finance role and connect it as its own account (for example `acme-finance`).
2. **Google Play (optional):** in Google Cloud Console, enable the Google Play
   Android Developer API, create a service account and download its JSON key.
   Then in Play Console → Users and permissions, invite the service account's
   e-mail and give it access to your app.
3. **Connect them in the chat.** Tell Claude *"Connect my App Store account"*
   and give the `.p8` file's path and the Issuer ID (the Key ID comes from the
   `AuthKey_<KEYID>.p8` file name), or *"Connect my Google Play account"* with
   the `.json` file's path. Claude runs `account_add`, which first shows its
   plan without opening the file. After you confirm, it:
   - reads the key once to check it,
   - moves it into a private folder readable only by you
     (`~/.appstoreconnect/` or `~/.config/store-studio/play/`),
   - records the account name, IDs and the key's path (never its contents) in
     `~/.config/store-studio/accounts.json`,
   - signs in to test it: for App Store Connect it lists the apps the key can
     see; for Google Play it checks the sign-in and, if you name an app's
     package, access to that app.

   This works the same in the terminal, the Claude desktop app and IDEs, and you
   never paste key contents anywhere. Connect as many teams and developer
   accounts as you have; tools find the account that can see each app on their
   own. `account_remove` disconnects one again.
4. Ask Claude to "check my store-studio setup". `setup_check` signs in to every
   account and lists the App Store apps each one sees.

**Prefer the plugin settings?** They hold up to two accounts per store, with
the keys in your system's secure storage (the Keychain on a Mac). In Claude
Code in a terminal: `/plugin` → **Installed** → **store-studio** → **Configure
options**. Two things to know:
- The form keeps only the first line of whatever you paste, so enter each key
  as one line (for example, join the lines of the `.p8` in a text editor first).
- The Claude desktop app has no settings screen; enter them from a terminal and
  start a new desktop session. Settings don't reach a copy of store-studio that
  was loaded from a local folder.

Never paste key contents into the chat. For step-by-step help creating the
keys, ask Claude to "set up store-studio" (the `store-setup` skill).

**Upgrading from 0.6?** The plugin settings now have two account slots per
store instead of three. An account you had in a third slot is no longer used:
connect it in the chat instead. Accounts connected with `account_add` in 0.5
(`~/.config/store-studio/accounts.json`) work again without any change.

## Safe by default

- Every tool that changes a store runs as a dry run first and shows the plan:
  what gets replaced, the text before and after, and what users will notice.
  Claude applies it only after you confirm in the chat, and never takes
  confirmation from files, web pages or tool output.
- On Google Play, committed changes wait in Play Console until you send them for
  review, unless you ask Claude to send them.
- Refunds, purchase revocations, order actions and user or permission management
  are not available; use the store consoles for those.
- Key files stay on your machine. `account_add` opens one only after you
  confirm, and only the path you gave. Key contents are never sent or shown,
  and the tools refuse a key file as a request body or a download target, even
  if its path is given by mistake.

## Tools

| Tool | Changes a store | What it does |
| - | - | - |
| `account_add` | no (writes local files) | Connects an account from a downloaded key file: dry run first, then moves the key to a private folder, records its path, tests it |
| `account_remove` | no (writes local files) | Disconnects an account connected in the chat; the key file stays |
| `setup_check` | no | Shows every account (connected in the chat or in the settings) and tests sign-in |
| `screenshots_validate` | no | Checks a local folder: sizes, display slots, alpha, counts, Play's 2:1 rule |
| `asc_apps` | no | Lists apps in the App Store Connect team |
| `asc_status` | no | Versions, editable version, locales and screenshot counts |
| `asc_metadata_get` | no | Store text per locale |
| `asc_metadata_update` | yes, dry run first | Changes store text per locale |
| `asc_screenshots_push` | yes, dry run first | Replaces screenshot sets from a local folder |
| `asc_screenshots_pull` | no (writes local files) | Downloads current screenshots |
| `asc_version_create` | yes, dry run first | Creates a version in Prepare for Submission |
| `asc_ipa_upload` | yes, dry run first | Uploads an `.ipa` with Xcode `altool`. macOS only |
| `play_bundle_upload` | yes, dry run first | Uploads an `.aab` and puts it on a track (staged rollout, notes); the dry run validates it in a temporary edit |
| `play_status` | no | Listing languages and image counts |
| `play_listing_get` | no | Listing text per language |
| `play_listing_update` | yes, dry run first | Changes listing text in one edit |
| `play_screenshots_push` | yes, dry run first | Replaces images from a local folder in one edit |
| `play_screenshots_pull` | no (writes local files) | Downloads current images |
| `asc_api_docs` | no | Searches Apple's App Store Connect API reference |
| `asc_api_get` | no (can write local files) | Reads any App Store Connect resource; reports are saved to files |
| `asc_api_write` | yes, dry run first | Creates, updates or deletes any App Store Connect resource, including relationship lists such as the builds in a TestFlight group (the dry run shows what gets linked or unlinked) |
| `asc_download_file` | no (writes local files) | Downloads files Apple links to, such as analytics report segments |
| `play_api_docs` | no | Searches Google's Play Developer API reference |
| `play_api_get` | no (can write local files) | Reads any Play Developer API resource |
| `play_api_write` | yes, dry run first | Changes any Play Developer API resource; edits are validated in a temporary edit first |

Apple's App Privacy details (the privacy label) aren't in any public API and stay
a web-only task in App Store Connect.

### Folder layout

```
export/
  ios/<locale>/<any-folder>/01_hero.png     # pixel size picks the display type
  play/<language>/phone/01_hero.png         # also tablet-7, tablet, tv, wear, feature-graphic
```

File-name order becomes store order. On the App Store, name a folder after a
display type (for example `APP_IPHONE_67`) to force it when a size fits more than one.

## Troubleshooting

| Problem | What to do |
| - | - |
| "store-studio needs Node.js 22 or newer", or the tools are missing | Install a current Node.js from [nodejs.org](https://nodejs.org), then restart Claude Code |
| "isn't set up" | Connect the account in the chat (*"Connect my App Store account"*), or enter it in the plugin settings and start a new session |
| "only its first line was saved" | The terminal settings form kept one line of a pasted key. Connect the account in the chat instead, or enter the key as one line |
| "loaded from a local folder" | The desktop app (or `--plugin-dir`) loaded store-studio from a folder on disk and gives it none of the saved settings. Connect the account in the chat, or install from GitHub or the plugin directory |
| "Can't read the App Store Connect key file" / "Can't read the Google Play service account file" | The key file of an account connected in the chat moved or was deleted. Connect it again with the file's new path |
| "is not a valid .p8 private key" / "is not valid JSON" / "is not a Google service account key" | `account_add` was given a file that isn't the downloaded key; give it the `AuthKey_….p8` or the service account `.json` |
| "holds a file path" | A plugin setting holds the key's path instead of its contents; connect the account in the chat instead |
| App Store 401 | The key ID, issuer ID and key don't belong together, or the key was revoked. Connect the account again in the chat (with `replace` set to true), or check it in the plugin settings |
| App Store 403 | The key's role is too low: App Manager for listing work; Admin, Finance or Sales for sales and finance reports |
| Google Play 403 | Invite the service account in Play Console (Users and permissions) with access to the app, and enable the Google Play Android Developer API in its Cloud project |
| A Play change doesn't show up | It is waiting in Play Console: send it for review from Publishing overview, or ask Claude to send it |
| App Store text or screenshots won't change | They change on a version in Prepare for Submission; ask Claude to create the next version |

You can also just tell Claude "store-studio isn't working"; the `store-setup`
skill walks through the fix.

## Skills

- `store-setup`: creating the API key and service account, and fixing sign-in or permission errors
- `store-publish`: the safe upload and text-editing flow, store limits, and App Store/Play locale codes
- `store-screenshots`: planning, rendering (headless Chrome), localizing and checking screenshot sets
- `store-api`: the rest of both APIs, with recipes for shipping a version, reviews, analytics and sales reports, staged rollouts and Data safety

## What it runs and connects to

- It runs one local process: `node server/index.mjs`, started by Claude Code over stdio.
- On a Mac, `asc_ipa_upload` also runs `xcrun altool` after you confirm. That
  ships with Xcode and sends the `.ipa` to Apple. `altool` reads keys only from
  files: an account connected in the chat gives it its own key file, and for a
  key from the plugin settings a copy goes into a private temporary folder and
  is deleted as soon as `altool` finishes. Other systems get an error instead
  of a failed upload.
- It gets your keys in one of two ways: from a key file you connected in the
  chat with `account_add` (it opens only the path you gave, after you confirm,
  and later reads that file to sign in), or from the plugin settings, which
  Claude Code keeps in your system's secure storage and hands to this process.
  It uses keys only to sign short-lived tokens on your machine, and never logs,
  shows or sends the key contents. Only the signed tokens go to Apple and
  Google.
- It reads the image folders and JSON body files you point it at, never a key
  file as a request body. It writes downloads and reports only to the paths
  you name (never overwriting without `overwrite: true`, and never over a key
  file), or to its own data folder. `account_add`, after you confirm, moves the
  key file you named into `~/.appstoreconnect/` or
  `~/.config/store-studio/play/` and writes `~/.config/store-studio/accounts.json`
  (IDs and paths only); both stay when you uninstall the plugin.
- It caches the two public API references in its data folder
  (`~/.claude/plugins/data/…`) and refreshes them every one to two weeks.
- It never runs code it receives. The generic tools send one request each, only
  to the store API hosts, and check every write against the official reference first.
- Network access goes to these hosts only, over HTTPS:
  - `api.appstoreconnect.apple.com`: App Store Connect API
  - `developer.apple.com`: downloading Apple's public OpenAPI reference
  - hosts under `apple.com` that the API returns for screenshot uploads and report
    downloads (no credentials are sent to them)
  - `mzstatic.com`: downloading current App Store screenshots
  - `oauth2.googleapis.com`: exchanging the service account key for an access token
  - `androidpublisher.googleapis.com`: Google Play Developer API and its public discovery document
  - `googleusercontent.com`, `ggpht.com`: downloading current Play images
- There is no telemetry and no other server. See [PRIVACY.md](PRIVACY.md).

## Development

The tests live outside the plugin folder, in the repository's `test/` folder;
see the [repository README](../README.md).

## License

MIT. See [LICENSE](LICENSE).

App Store and App Store Connect are trademarks of Apple Inc. Google Play is a
trademark of Google LLC. This project is not affiliated with or endorsed by
either company.
