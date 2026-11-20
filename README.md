# Fruti Launcher

A minimal game launcher made of plain HTML, CSS and JavaScript. **No server needed:** download the folder and double-click `index.html`. It also works on GitHub Pages.

## Adding games

Edit `games.js`.

- **Flash (.swf) games:** convert the file once, then add an entry with `swf: "<id>"`:

  ```bash
  python3 tools/embed.py swf path/to/my-game.swf my-game
  ```

  This writes `games/my-game.js`. Flash games play through [Ruffle](https://ruffle.rs) 0.7.1, which is bundled in `ruffle/`.
- **Nintendo 64 games:** convert the ROM once, then add an entry with `rom: "<id>"`. It shows in the Nintendo 64 tab:

  ```bash
  python3 tools/embed.py rom path/to/my-game.z64 my-game
  ```

  N64 games play through [EmulatorJS](https://github.com/EmulatorJS/EmulatorJS) 4.2.3 (bundled in `emulatorjs/`, GPL-3.0). The Nintendo 64 tab also has a **Play a ROM** box that plays a ROM straight from your computer without adding it.
- **Web games:** set `url` to the page to load instead.
- `image` is the cover picture. Covers are screenshots of each game, saved in `covers/` as JPGs. Games without one get a gradient from `color`.

### Why games are `.js` files

Browsers block `fetch()` for pages opened from disk (`file://`), so normal `.swf` and `.wasm` files can't load without a server. Script tags are allowed, though, so each game and the Ruffle engine are stored as base64 inside `.js` files and loaded that way.

## Features

- Featured "Continue Playing" banner that rotates and puts recently played games first
- Recommended row, plus a searchable Library
- Games open in their own browser tab, titled with the game name
- Collapsible right sidebar with Fruti, Library, Flash, Nintendo 64 and Settings, plus played history and a clock
- Settings: theme color and background particles (none, snow, rain, stars, bubbles, fireflies, nexus)

## Fonts

- **Rostex** (`fonts/rostex.otf`): the "FRUTI" boot screen and the section headings, such as "Continue Playing", "Games We Recommend" and "Strategy & Tower Defense".
- **Easy Noise** (`fonts/easy-noise.ttf`): all other text, including the sidebar, top bar, cards and game pages.

Both are embedded in `style.css` as base64, so they also work when the page is opened from disk.
