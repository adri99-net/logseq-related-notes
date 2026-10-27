# Related Notes (Logseq plugin)

Shows the N most semantically similar pages to the one you're viewing, in a docked panel on the right.

- Embeds pages locally with `Xenova/bge-small-en-v1.5` (quantised, ~35 MB), downloaded from Hugging Face on first run and cached by the browser.
- Vectors are stored in IndexedDB inside the plugin; only changed pages are re-embedded.
- Settings: number of results (default 10), model id, ignore journals, max characters per page, panel width.
- Commands (Cmd/Ctrl+Shift+P): toggle panel, re-index changed pages, rebuild index.
- Click a result to open it, Shift-click to open it in Logseq's right sidebar.

## Install
Logseq → Settings → Advanced → Developer mode on → Plugins → Load unpacked plugin → select this folder (the one containing package.json and dist/).

## Develop
npm install --ignore-scripts && npm run build

## License
MIT licensed. See LICENSE.

Third-party licences for the bundled libraries are listed in THIRD_PARTY_NOTICES.md.
