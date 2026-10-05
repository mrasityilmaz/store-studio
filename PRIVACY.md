# Privacy

store-studio runs entirely on your machine as a local process started by Claude Code.

- **No data collection.** It has no telemetry, analytics or server of its own.
- **Credentials.** It reads the App Store Connect `.p8` key and the Google Play
  service account JSON from the paths you configure, only to sign short-lived
  access tokens locally. Key contents are never stored, logged, shown to Claude
  or sent anywhere. Only the signed tokens go to Apple and Google.
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
- **What Claude sees.** Tool results (app names, store text, locale lists, image
  sizes, upload results) are returned to Claude Code, which handles them under
  your Claude plan's terms.

Questions: open an issue at https://github.com/mrasityilmaz/store-studio/issues.
