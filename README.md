# Fruti Launcher

A minimal game launcher made of plain HTML, CSS and JavaScript. **No server needed:** download the folder and double-click `index.html`. It also works on GitHub Pages.

## Adding games

Edit `games.js`.

- **Flash (.swf) games:** convert the file once, then add an entry with `swf: "<id>"`:

  ```bash
  python3 tools/embed.py swf path/to/my-game.swf my-game
  ```

  This writes `games/my-game.js`. Flash games play through [Ruffle](https://ruffle.rs) 0.7.1, which is bundled in `ruffle/`.
- **Console games** (Nintendo DS, N64, GBA, Game Boy / Color, SNES, NES, Sega Genesis, PlayStation): each console has its own tab with a **Play a ROM** box that plays a ROM straight from your computer (any size, nothing is uploaded). To list a game permanently, convert it and add an entry with `rom: "<id>", console: "<console>"`:

  ```bash
  python3 tools/embed.py rom path/to/my-game.nds my-game nds
  ```

  Consoles are listed in `consoles.js`. Games play through [EmulatorJS](https://github.com/EmulatorJS/EmulatorJS) 4.2.3, bundled in `emulatorjs/` (GPL-3.0) with the melonDS, mupen64plus_next, mGBA, Gambatte, Snes9x, FCEUmm, Genesis Plus GX and PCSX ReARMed cores.
- **Web games:** set `url` to the page to load instead.
- `image` is the cover picture. Covers are screenshots of each game, saved in `covers/` as JPGs. Games without one get a gradient from `color`.

### Why games are `.js` files

Browsers block `fetch()` for pages opened from disk (`file://`), so normal `.swf` and `.wasm` files can't load without a server. Script tags are allowed, though, so each game and the Ruffle engine are stored as base64 inside `.js` files and loaded that way.

## Features

The launcher (`index.html`, `desktop.css`, `desktop.js`) has a desktop game-library layout:

- Page buttons at the top right: Library, Emulators, Statistics, Settings
- Toolbar with search, favorites filter, group by (genre / platform / none), sort, platform filter, random game and a "Filter Active" chip that clears filters
- Three views: **Details** (grouped, collapsible game list + a big details page with background art, Play button, time played and info panel), **Grid** (cover cards with a platform badge) and **List** (sortable table)
- Keyboard: `/` search, arrow keys to select, `Enter` to play, `F` to favorite; double-click a game to play it
- Settings: accent color, grid cover size, background art and grid titles

The previous design is still available as `classic.html` (linked from Settings). Its features:


- Featured "Continue Playing" banner that rotates and puts recently played games first
- Recommended row, plus a searchable Library
- Games open in their own browser tab, titled with the game name
- Collapsible right sidebar with Fruti, Library, Flash, a tab per console and Settings, plus played history and a clock
- Settings: theme color and background particles (none, snow, rain, stars, bubbles, fireflies, nexus)

## Fonts

- **Rostex** (`fonts/rostex.otf`): the "FRUTI" boot screen and the section headings, such as "Continue Playing", "Games We Recommend" and "Strategy & Tower Defense".
- **Easy Noise** (`fonts/easy-noise.ttf`): all other text, including the sidebar, top bar, cards and game pages.

Both are embedded in `style.css` as base64, so they also work when the page is opened from disk.
