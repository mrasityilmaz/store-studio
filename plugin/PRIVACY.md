# Privacy

store-studio runs entirely on your machine as a local process started by Claude Code.

- **No data collection.** It has no telemetry, analytics or server of its own.
- **Credentials.** You connect an account in one of two ways:
  - In the chat, with `account_add`: you give the path of the `.p8` key or the
    Google Play service account JSON you downloaded. The plugin opens that file
    only after you confirm, moves it into a private folder readable only by
    you, and records its path and IDs (never its contents) in
    `~/.config/store-studio/accounts.json`. Later it reads the file to sign in.
  - In the plugin settings, which keep the keys in your system's secure
    credential store (the Keychain on a Mac); Claude Code hands them to the
    local store-studio process.

  Either way the keys are used only to sign short-lived access tokens locally.
  Key contents are never logged, shown to Claude or sent anywhere; only the
  signed tokens go to Apple and Google. For a confirmed IPA upload on a Mac,
  Apple's `altool` reads the key from a file: a connected account's own file, or
  for a key from the settings a private temporary copy deleted as soon as
  `altool` finishes. The plugin never reads any other file for credentials.
- **Your files.** It reads the image folders you point it at and uploads them to
  the store you choose, after you confirm. Downloads are written only to the
  folder you name. On a Mac, a confirmed IPA upload hands the file to
  `xcrun altool`, which sends it to Apple.
- **Where data goes.** Store data, images and reports go only to and from Apple
  (`api.appstoreconnect.apple.com`, `developer.apple.com`, hosts under `apple.com`
  that the API returns, `mzstatic.com`) and Google (`oauth2.googleapis.com`,
  `androidpublisher.googleapis.com`, `googleusercontent.com`, `ggpht.com`). Their
  own privacy policies apply there.
- **Local cache.** The public API references and any reports you download without
  naming a path are kept in the plugin's data folder until you uninstall it.
- **Connected accounts.** `~/.config/store-studio/accounts.json` and the key files
  `account_add` moved stay when you uninstall the plugin; delete them yourself
  if you no longer need them (`account_remove` takes an account out of the file).
  Settings entered in the plugin settings are removed with the plugin.
- **Personal data.** When you ask for it, the plugin reads data from your own
  store accounts that can include personal data: customer review nicknames and
  texts, TestFlight tester names and e-mail addresses, and similar fields in
  other API responses. It doesn't store this data; it only writes a response
  to a local file when you name one.
- **What Claude sees.** Tool results (app names, store text, locale lists, image
  sizes, upload results, and whatever store data you ask for, including the
  personal data above) are returned to Claude Code, which handles them under
  your Claude plan's terms.

Questions: open an issue at https://github.com/mrasityilmaz/store-studio/issues.
