// Consoles shown in the Emulator tab and supported by emu.html (EmulatorJS 4.2.3).
// id:    EmulatorJS system name, also the folder for embedded ROMs (games/<id>/).
// tag:   short label used on badges and console tiles.
// ext:   ROM file types accepted by "Play a ROM file" (zip/7z are always accepted).
// color: tile colour in the Emulator tab.
// emu:   false = no emulator core in the browser yet; the console is listed but games can't be played.
window.FRUTI_CONSOLES = [
  { id: "nds",    name: "Nintendo DS",      tag: "DS",     color: "#c9ccd6", ext: [".nds"] },
  { id: "n64",    name: "Nintendo 64",      tag: "N64",    color: "#2f9e44", ext: [".z64", ".n64", ".v64"] },
  { id: "gba",    name: "Game Boy Advance", tag: "GBA",    color: "#5b3fd1", ext: [".gba"] },
  { id: "gb",     name: "Game Boy / Color", tag: "GB",     color: "#8bac0f", ext: [".gb", ".gbc"] },
  { id: "snes",   name: "Super Nintendo",   tag: "SNES",   color: "#7b6fc4", ext: [".sfc", ".smc"] },
  { id: "nes",    name: "NES",              tag: "NES",    color: "#d4372b", ext: [".nes"] },
  { id: "segaMD", name: "Sega Genesis",     tag: "MD",     color: "#1c5bd6", ext: [".md", ".gen", ".bin", ".smd"] },
  { id: "psx",    name: "PlayStation",      tag: "PS1",    color: "#8a8f9c", ext: [".chd", ".pbp", ".cue", ".bin", ".iso"] },
  { id: "gc",     name: "GameCube",         tag: "GC",     color: "#6a4fb3", ext: [".iso", ".gcm", ".rvz"], emu: false },
  { id: "switch", name: "Nintendo Switch",  tag: "NSW",    color: "#e60012", ext: [".nsp", ".xci"],         emu: false },
  { id: "mobile", name: "Mobile",           tag: "MOB",    color: "#14b8a6", ext: [".apk"],                 emu: false }
];
