# Related Notes (Logseq plugin)

Shows the N most semantically similar pages to the one you're viewing, in a docked panel on the right.

- Embeds pages locally with `Xenova/bge-small-en-v1.5` (quantised, ~35 MB), downloaded from Hugging Face on first run and cached by the browser.
- Vectors are stored in IndexedDB inside the plugin; only changed pages are re-embedded.
- Settings: number of results (default 10), model id, ignore journals, max characters per page, panel width.
- Commands (Cmd/Ctrl+Shift+P): toggle panel, re-index changed pages, rebuild index.
- Type in the search box to find pages by meaning (clear it or press Esc to go back to related notes).
- Click a result to open it, Shift-click to open it in Logseq's right sidebar.

## Install
Logseq → Settings → Advanced → Developer mode on → Plugins → Load unpacked plugin → select this folder (the one containing package.json and dist/).

## Develop
npm install --ignore-scripts && npm run build

## Updating
- **Installed from the Logseq marketplace:** open Plugins → Installed and click Update when it appears. Settings and the downloaded model are kept.
- **Installed manually:** download the latest release zip, replace the contents of the plugin folder, then reload the plugin (toggle it off and on, or restart Logseq).
- After an update that changes the model or how page text is processed, run **Related notes: rebuild index from scratch** once so cached vectors are regenerated.

## Releasing (maintainers)
1. Bump `version` in `package.json` (Logseq uses it to detect updates).
2. `npm run build`
3. Commit and tag: `git tag vX.Y.Z && git push --tags`
4. Zip `package.json icon.svg README.md LICENSE THIRD_PARTY_NOTICES.md dist` and attach it to a new GitHub release: `gh release create vX.Y.Z <zip>`

## License
MIT licensed. See LICENSE.

Third-party licences for the bundled libraries are listed in THIRD_PARTY_NOTICES.md.
