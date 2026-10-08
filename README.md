# store-studio

A Claude Code plugin for App Store Connect and Google Play: screenshots and
store text for every locale and device, builds and staged rollouts, TestFlight,
reviews, reports, and every other endpoint of both official APIs, with a dry
run before every change.

**Using it:** see the [plugin README](plugin/README.md) for setup, examples and
everything the plugin runs and connects to. Privacy: [plugin/PRIVACY.md](plugin/PRIVACY.md).

```
/plugin marketplace add mrasityilmaz/store-studio
/plugin install store-studio@store-studio
```

## Repository layout

```
.claude-plugin/marketplace.json   this repository as a Claude Code marketplace
plugin/                           the plugin itself (manifest, MCP server, skills, docs)
test/                             tests, kept outside the plugin
```

## Development

Plain Node.js 22+, no dependencies.

```
node test/run.mjs
```

The tests generate their own keys, images and reference fixtures, and run every
tool that talks to a store against an in-process fake of both APIs. They check
token signatures, upload parts, checksums, ordering, edit commits, dry runs,
blocked endpoints, path tricks, key-file protection, retry rules, and that
credentials only go to the API hosts.

To try local changes in a terminal, start Claude Code with
`claude --plugin-dir ./plugin`. A plugin loaded from a folder (that, or this
folder added as a marketplace) runs as `store-studio@inline` and gets none of
the settings saved for the installed `store-studio@store-studio`; the Claude
desktop app does the same for local-folder marketplaces. To use your accounts,
install from GitHub (`claude plugin marketplace add mrasityilmaz/store-studio`)
or enter the settings again for the folder copy.

## License

MIT. See [LICENSE](LICENSE).

App Store and App Store Connect are trademarks of Apple Inc. Google Play is a
trademark of Google LLC. This project is not affiliated with or endorsed by
either company.
