# Fruti Launcher

A minimal game launcher made of plain HTML, CSS and JavaScript. **No server needed:** download the folder and double-click `index.html`. It also works on GitHub Pages.

## Adding games

Edit `games.js`.

- **Flash (.swf) games:** convert the file once, then add an entry with `swf: "<id>"`:

  ```bash
  python3 tools/embed.py swf path/to/my-game.swf my-game
  ```

  This writes `games/my-game.js`. Flash games play through [Ruffle](https://ruffle.rs) 0.7.1, which is bundled in `ruffle/`.
- **Web games:** set `url` to the page to load instead.
- `image` is an optional cover; games without one get a gradient from `color`.

### Why games are `.js` files

Browsers block `fetch()` for pages opened from disk (`file://`), so normal `.swf` and `.wasm` files can't load without a server. Script tags are allowed, though, so each game and the Ruffle engine are stored as base64 inside `.js` files and loaded that way.

## Features

- Featured "Continue Playing" banner that rotates and puts recently played games first
- Recommended row, plus a searchable Library
- Collapsible right sidebar with played history, clock and total play time (saved in the browser)
