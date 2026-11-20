# Fruti Launcher

A minimal static game launcher. Host the folder on any static host (GitHub Pages, Cloudflare Pages, …) or run it locally:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. Flash games won't load if you open `index.html` straight from disk; they need to be served over http.

## Adding games

Edit `games.js`.

- **Flash (.swf) games:** put the file in `games/` and set `swf: "games/<file>.swf"`. They play through [Ruffle](https://ruffle.rs) (v0.7.1), which is bundled in `ruffle/`, so no CDN is needed.
- **Web games:** set `url` to the page to load instead.
- `image` is an optional cover; games without one get a gradient from `color`.

## Features

- Featured "Continue Playing" banner that rotates and puts recently played games first
- Recommended row, plus a searchable Library
- Collapsible right sidebar with played history, clock and total play time (saved in the browser)
