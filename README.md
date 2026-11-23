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

- Featured "Continue Playing" banner that rotates and puts recently played games first
- Recommended row, plus a searchable Library
- Games open in their own browser tab, titled with the game name
- Collapsible right sidebar with Fruti, Library, Flash, a tab per console and Settings, plus played history and a clock
- Settings: theme color and background particles (none, snow, rain, stars, bubbles, fireflies, nexus)

## Fonts

- **Rostex** (`fonts/rostex.otf`): the "FRUTI" boot screen and the section headings, such as "Continue Playing", "Games We Recommend" and "Strategy & Tower Defense".
- **Easy Noise** (`fonts/easy-noise.ttf`): all other text, including the sidebar, top bar, cards and game pages.

Both are embedded in `style.css` as base64, so they also work when the page is opened from disk.

## Fruti World (open-world city generator)

`world/` is a 3D open-world game built with three.js. Type a seed and pick the city size, skyline height, density, palms, traffic, pedestrians and time of day; the same seed always makes the same city. Then walk around, take any car (F), drift with the handbrake (Space), and watch the city light up at night. Keyboard + mouse, gamepad and touch controls all work.

It runs straight from disk: everything (three.js, textures, the road pack and the character) is bundled into `world/world.js`. To change the code, edit `world/src/` and rebuild:

```bash
cd world && npm install && npm run build
```

Credits are in `world/CREDITS.md`.
