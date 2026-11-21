// Fruti Launcher game list.
//
// Every game has: id (also the art/ and covers/ file name), title, tags, image, color, desc
// and ONE source:
//   cdn: "<path in rom-games>"   console ROM loaded from FRUTI_ROM_SOURCES (set console: too)
//   rom: "<id>"                  console ROM embedded in games/<console>/<id>.js (tools/embed.py rom ...)
//   swf: "<id>"                  Flash game embedded in games/<id>.js (tools/embed.py swf ...), played with Ruffle
//   url: "<page>"                web (HTML5) game, opened in a new tab
// Leave the source empty ("") to list a game that isn't set up yet; it shows a "Setup needed" badge.
// image: cover in covers/. Run  python3 tools/make-art.py  after adding one to build the tile + hero art.

// ROM hosts, tried in order. jsDelivr is fast but refuses files over 20 MB, so GitHub raw is the fallback.
window.FRUTI_ROM_SOURCES = [
  "https://cdn.jsdelivr.net/gh/jogresh7-ship-it/rom-games@main/",
  "https://raw.githubusercontent.com/jogresh7-ship-it/rom-games/main/"
];

window.FRUTI_GAMES = [
  // ---- Console ROMs (rom-games CDN) ----
  { id: "mario-kart-ds",              title: "Mario Kart DS",                   tags: ["Racing", "Multiplayer"],   console: "nds", cdn: "roms/nds/Mario Kart DS (USA) (En,Fr,De,Es,It).nds",                  image: "covers/mario-kart-ds.jpg",              color: ["#e52521", "#1e40af"], desc: "Race Mario and friends across 32 tracks, grab items and drift-boost your way to the gold cup." },
  { id: "new-super-mario-bros-ds",    title: "New Super Mario Bros.",           tags: ["Platformer"],              console: "nds", cdn: "roms/nds/New Super Mario Bros. (USA, Australia).nds",                image: "covers/new-super-mario-bros-ds.jpg",    color: ["#e52521", "#fbbf24"], desc: "Classic side-scrolling Mario with mega mushrooms, shells and eight worlds to stomp through." },
  { id: "pokemon-platinum",           title: "Pokémon Platinum",                tags: ["RPG", "Adventure"],        console: "nds", cdn: "roms/nds/Pokemon - Platinum Version (USA) (Rev 1).zip",              image: "covers/pokemon-platinum.jpg",           color: ["#4b5563", "#b45309"], desc: "Explore the Sinnoh region, catch Pokémon and stop Team Galactic, with Giratina and the Distortion World." },
  { id: "ocarina-of-time",            title: "The Legend of Zelda: Ocarina of Time", tags: ["Adventure", "Action"], console: "n64", cdn: "roms/n64/Legend of Zelda, The - Ocarina of Time (U) (V1.2) [!].z64", image: "covers/ocarina-of-time.jpg",            color: ["#14532d", "#b45309"], desc: "Travel through time as Link to stop Ganondorf. Dungeons, puzzles and the ocarina that changes everything." },
  { id: "pokemon-ultra-violet",       title: "Pokémon Ultra Violet",            tags: ["RPG", "ROM Hack"],         console: "gba", cdn: "roms/gba/Pokemon Ultra Violet (1.22) LSA (Fire Red Hack).gba",        image: "covers/pokemon-ultra-violet.jpg",       color: ["#6d28d9", "#db2777"], desc: "A FireRed hack with Pokémon from every generation, new moves and a fresh challenge through Kanto." },
  { id: "f1-2002",                    title: "F1 2002",                         tags: ["Racing", "Sports"],        console: "gba", cdn: "roms/gba/F1 2002 (USA, Europe).gba",                                  image: "covers/f1-2002.jpg",                    color: ["#b91c1c", "#111827"], desc: "Formula One racing on the Game Boy Advance, with the 2002 teams, drivers and circuits." },
  { id: "super-mario-bros-2",         title: "Super Mario Bros. 2",             tags: ["Platformer"],              console: "nes", cdn: "roms/nes/Super Mario Bros. 2 (USA) (Rev 1).nes",                      image: "covers/super-mario-bros-2.jpg",         color: ["#1d4ed8", "#dc2626"], desc: "Pluck vegetables and throw them at Shy Guys in the dream land of Subcon. Pick Mario, Luigi, Toad or Peach." },
  { id: "super-mario-bros-duck-hunt", title: "Super Mario Bros. + Duck Hunt",   tags: ["Platformer", "Arcade"],    console: "nes", cdn: "roms/nes/Super Mario Bros. + Duck Hunt (USA).nes",                    image: "covers/super-mario-bros-duck-hunt.jpg", color: ["#dc2626", "#0ea5e9"], desc: "The original Super Mario Bros. adventure, plus Duck Hunt on the same cartridge." },

  // ---- Web games ----
  { id: "plants-vs-zombies-ds",       title: "Plants vs. Zombies DS",           tags: ["Strategy", "Tower Defense"], url: "", image: "", color: ["#65a30d", "#3f6212"], desc: "Plant sunflowers, peashooters and wall-nuts to stop the zombies before they reach your house." },
  { id: "flappy-birds",               title: "Flappy Birds",                    tags: ["Arcade"],                    url: "", image: "", color: ["#38bdf8", "#facc15"], desc: "Tap to flap and squeeze through the pipes. One mistake and it's over." },

  // ---- Flash games (Ruffle) ----
  { id: "bloons-td-5",                title: "Bloons Tower Defense 5",          tags: ["Strategy", "Tower Defense"], swf: "", image: "", color: ["#f59e0b", "#dc2626"], desc: "The biggest Bloons TD: upgrade paths, specialty buildings and loads of tracks." },
  { id: "bloons-td-4",             title: "Bloons Tower Defense 4",   tags: ["Strategy", "Tower Defense"], swf: "bloons-td-4",             image: "covers/bloons-td-4.jpg",             color: ["#ff512f", "#f09819"], desc: "Place monkey towers along the track and pop every bloon before it gets through. More towers, upgrades and tougher rounds than ever." },
  { id: "commando-2",              title: "Commando 2",               tags: ["Action", "Shooter"],         swf: "commando-2",              image: "covers/commando-2.jpg",              color: ["#3e2a1a", "#a0522d"], desc: "Fight through enemy territory as an elite commando. Grab new weapons, take out soldiers and survive each mission." },
  { id: "bloons-super-monkey",     title: "Bloons Super Monkey",      tags: ["Shooter", "Arcade"],         swf: "bloons-super-monkey",     image: "covers/bloons-super-monkey.jpg",     color: ["#8e2de2", "#ff6a88"], desc: "Fly as the Super Monkey and blast waves of bloons. Earn upgrades between levels to boost your firepower." },
  { id: "build-the-bridge",        title: "Build the Bridge",         tags: ["Puzzle", "Physics"],         swf: "build-the-bridge",        image: "covers/build-the-bridge.jpg",        color: ["#c0392b", "#f39c12"], desc: "Design a bridge strong enough for the train to cross, using as little budget as you can." },
  { id: "bob-the-robber",          title: "Bob the Robber",           tags: ["Stealth", "Puzzle"],         swf: "bob-the-robber",          image: "covers/bob-the-robber.jpg",          color: ["#141e30", "#4a6fa5"], desc: "Sneak past guards and cameras, crack safes and grab the loot without getting caught." },
  { id: "canabalt",                title: "Canabalt",                 tags: ["Runner", "Arcade"],          swf: "canabalt",                image: "covers/canabalt.jpg",                color: ["#4b4b5a", "#7a7a8c"], desc: "Run across rooftops of a collapsing city and jump the gaps. One button, how far can you get? Press X or C to jump." },
  { id: "bloons-td-3",             title: "Bloons Tower Defense 3",   tags: ["Strategy", "Tower Defense"], swf: "bloons-td-3",             image: "covers/bloons-td-3.jpg",             color: ["#11998e", "#38ef7d"], desc: "The classic tower defense: build darts, tacks and bombs to stop the bloon invasion across multiple tracks." },
  { id: "boxhead-the-zombie-wars", title: "Boxhead: The Zombie Wars", tags: ["Shooter", "Zombies"],        swf: "boxhead-the-zombie-wars", image: "covers/boxhead-the-zombie-wars.jpg", color: ["#1d4350", "#a43931"], desc: "Hold off the zombie hordes with an ever-growing arsenal of weapons and barricades." },
  { id: "bloxorz",                 title: "Bloxorz",                  tags: ["Puzzle"],                    swf: "bloxorz",                 image: "covers/bloxorz.jpg",                 color: ["#434343", "#f7971e"], desc: "Roll a rectangular block across floating tiles and drop it into the square hole. Simple to learn, hard to master." },
  { id: "bubble-tanks-2",          title: "Bubble Tanks 2",           tags: ["Shooter", "Arcade"],         swf: "bubble-tanks-2",          image: "covers/bubble-tanks-2.jpg",          color: ["#00c6ff", "#0072ff"], desc: "Pilot a bubble tank through a giant bubble universe, absorb enemies and evolve into bigger tanks." },
  { id: "checkers",                title: "Checkers",                 tags: ["Board", "Strategy"],         swf: "checkers",                image: "covers/checkers.jpg",                color: ["#1e3c72", "#b21f1f"], desc: "Classic checkers against the computer or a friend. Jump your opponent's pieces and reach the far side to king them." },
  { id: "boxhead-2play-rooms",     title: "Boxhead: 2Play Rooms",     tags: ["Shooter", "Co-op"],          swf: "boxhead-2play-rooms",     image: "covers/boxhead-2play-rooms.jpg",     color: ["#3a1c71", "#d76d77"], desc: "Survive endless waves of zombies and devils, alone or with a friend on the same keyboard." },
  { id: "bloons-td-2",             title: "Bloons Tower Defense 2",   tags: ["Strategy", "Tower Defense"], swf: "bloons-td-2",             image: "covers/bloons-td-2.jpg",             color: ["#fc466b", "#3f5efb"], desc: "Where tower defense got popular. Set up monkeys along the path and keep the bloons from escaping." }
];
