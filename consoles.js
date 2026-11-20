// Consoles shown as tabs in the launcher and supported by emu.html (EmulatorJS).
// id:   EmulatorJS system name, also the folder for embedded ROMs (games/<id>/).
// tag:  short label used as the tab icon.
// ext:  ROM file types accepted by "Play a ROM" (zip/7z are always accepted).
window.FRUTI_CONSOLES = [
  { id: "nds",    name: "Nintendo DS",      tag: "DS",   ext: [".nds"] },
  { id: "n64",    name: "Nintendo 64",      tag: "N64",  ext: [".z64", ".n64", ".v64"] },
  { id: "gba",    name: "Game Boy Advance", tag: "GBA",  ext: [".gba"] },
  { id: "gb",     name: "Game Boy / Color", tag: "GB",   ext: [".gb", ".gbc"] },
  { id: "snes",   name: "Super Nintendo",   tag: "SNES", ext: [".sfc", ".smc"] },
  { id: "nes",    name: "NES",              tag: "NES",  ext: [".nes"] },
  { id: "segaMD", name: "Sega Genesis",     tag: "MD",   ext: [".md", ".gen", ".bin", ".smd"] },
  { id: "psx",    name: "PlayStation",      tag: "PS1",  ext: [".chd", ".pbp", ".cue", ".bin", ".iso"] }
];
