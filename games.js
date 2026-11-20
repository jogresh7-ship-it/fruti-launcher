// Add your games here.
// Flash games: run  python3 tools/embed.py swf my-game.swf <id>  then set swf: "<id>" (played with Ruffle).
// Web games:   set url: "<page to load>" instead.
// image: optional cover image URL — if empty, a gradient is used.
// color: two gradient colors used when no image is set.
// desc:  short description shown on the game page.
window.FRUTI_GAMES = [
  { id: "bloons-td-4",         title: "Bloons Tower Defense 4", tags: ["Strategy", "Tower Defense"], swf: "bloons-td-4",         desc: "Place monkey towers along the track and pop every bloon before it gets through. More towers, upgrades and tougher rounds than ever.", image: "", color: ["#ff512f", "#f09819"] },
  { id: "bad-ice-cream-3",     title: "Bad Ice Cream 3",        tags: ["Puzzle", "Arcade"],          swf: "bad-ice-cream-3",     desc: "Guide your ice cream through icy mazes, collect all the fruit and dodge the enemies. Build and break ice walls to block them.", image: "", color: ["#36d1dc", "#5b86e5"] },
  { id: "bloons-super-monkey", title: "Bloons Super Monkey",    tags: ["Shooter", "Arcade"],         swf: "bloons-super-monkey", desc: "Fly as the Super Monkey and blast waves of bloons. Earn upgrades between levels to boost your firepower.", image: "", color: ["#8e2de2", "#ff6a88"] },
  { id: "bloons-td-3",         title: "Bloons Tower Defense 3", tags: ["Strategy", "Tower Defense"], swf: "bloons-td-3",         desc: "The classic tower defense: build darts, tacks and bombs to stop the bloon invasion across multiple tracks.", image: "", color: ["#11998e", "#38ef7d"] },
  { id: "bloons-td-2",         title: "Bloons Tower Defense 2", tags: ["Strategy", "Tower Defense"], swf: "bloons-td-2",         desc: "Where tower defense got popular. Set up monkeys along the path and keep the bloons from escaping.", image: "", color: ["#fc466b", "#3f5efb"] },
  { id: "bloxorz",                 title: "Bloxorz",                 tags: ["Puzzle"],             swf: "bloxorz",                 desc: "Roll a rectangular block across floating tiles and drop it into the square hole. Simple to learn, hard to master.", image: "", color: ["#434343", "#f7971e"] },
  { id: "bob-the-robber",          title: "Bob the Robber",          tags: ["Stealth", "Puzzle"],  swf: "bob-the-robber",          desc: "Sneak past guards and cameras, crack safes and grab the loot without getting caught.", image: "", color: ["#141e30", "#4a6fa5"] },
  { id: "boxhead-2play-rooms",     title: "Boxhead: 2Play Rooms",    tags: ["Shooter", "Co-op"],   swf: "boxhead-2play-rooms",     desc: "Survive endless waves of zombies and devils, alone or with a friend on the same keyboard.", image: "", color: ["#3a1c71", "#d76d77"] },
  { id: "boxhead-the-zombie-wars", title: "Boxhead: The Zombie Wars",tags: ["Shooter", "Zombies"], swf: "boxhead-the-zombie-wars", desc: "Hold off the zombie hordes with an ever-growing arsenal of weapons and barricades.", image: "", color: ["#1d4350", "#a43931"] },
  { id: "bubble-tanks-2",          title: "Bubble Tanks 2",          tags: ["Shooter", "Arcade"],  swf: "bubble-tanks-2",          desc: "Pilot a bubble tank through a giant bubble universe, absorb enemies and evolve into bigger tanks.", image: "", color: ["#00c6ff", "#0072ff"] }
];
