# Fruti Launcher

A minimal game launcher made of plain HTML, CSS and JavaScript. **No server needed:** download the folder and double-click `index.html`. It also works on GitHub Pages.

## Adding games

Edit `games.js`. Each game has one source:

- **Console ROMs from the CDN** (`cdn:`): the path of the ROM inside the [rom-games](https://github.com/jogresh7-ship-it/rom-games) repo, plus `console:`. ROMs download from `FRUTI_ROM_SOURCES` at the top of `games.js`: jsDelivr first, then GitHub raw. jsDelivr refuses files over 20 MB, so big ROMs (Mario Kart DS, Ocarina of Time) come from GitHub raw automatically.
- **Embedded console ROMs** (`rom:`): convert once with `python3 tools/embed.py rom path/to/my-game.nds my-game nds`, then add `rom: "my-game", console: "nds"`.
- **Flash (.swf) games** (`swf:`): convert once with `python3 tools/embed.py swf path/to/my-game.swf my-game`, then add `swf: "my-game"`. Played with [Ruffle](https://ruffle.rs) 0.7.1, bundled in `ruffle/`.
- **Web games** (`url:`): the page to open.

Leave the source empty (`""`) to list a game that isn't set up yet. It shows a **SETUP** badge and explains what's missing.

Consoles are listed in `consoles.js`. Games play through [EmulatorJS](https://github.com/EmulatorJS/EmulatorJS) 4.2.3, bundled in `emulatorjs/` (GPL-3.0) with the melonDS, mupen64plus_next, mGBA, Gambatte, Snes9x, FCEUmm, Genesis Plus GX and PCSX ReARMed cores. GameCube, Switch and Mobile are listed with `emu: false` because no browser core exists for them. Each console page also has **Play a ROM file…** to play a ROM straight from your computer (nothing is uploaded).

### Artwork

Put a cover in `covers/<id>.jpg` (`<id>` = the game id), set `image:` and run:

```bash
python3 tools/make-art.py
```

This builds `art/<id>.webp` (square tile) and `art/<id>-hero.webp` (wide banner) with the blur baked in, so the launcher never blurs anything while it runs. Console covers are box art from [libretro-thumbnails](https://github.com/libretro-thumbnails). Games without a cover get a gradient from `color`.

### Why games are `.js` files

Browsers block `fetch()` for pages opened from disk (`file://`), so normal `.swf` and `.wasm` files can't load without a server. Script tags are allowed, though, so each game and the Ruffle engine are stored as base64 inside `.js` files and loaded that way.

## Features

- Left navigation rail (bottom bar on phones): Home, Library, Emulator, Flash, Settings
- Home: rotating hero banner (recently played first), then Continue playing, Console classics, Flash, Web and genre rows
- Library: search (press `/`), filter by Consoles, Flash, Web or a single console, and sort by name, recently played or most played
- Emulator: a tile per console with game counts, and a page per console
- Details sheet with play time and last played; games open in their own browser tab
- Arrow keys move between game cards; Esc closes the details sheet
- Settings: accent color, background effect (off by default), hero rotation, reduce motion, ROM sources, clear play data
- History and play time use the same `localStorage` keys as before, so nothing is lost

## Fonts

- **Rostex** (`fonts/rostex.otf`): page titles, hero titles and game titles. Embedded in `fonts.css` as base64, so it also works when the page is opened from disk.
- **Inter** (Google Fonts) for everything else, falling back to the system font offline.
