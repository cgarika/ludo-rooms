/* Ludo — rules unit suite (no sockets). Run from repo root: node test/rules.js
   T8: bot priorities on scripted positions (classic cross board: M=52, red starts 0, green 13, safe cells
   0 8 13 21 26 34 39 47, track ends at 50, lane 51–55, finish 56). */
const { buildConfig, legalMoves, botPick } = require("../server.js");
let failed = 0; const ok = (m) => console.log("  ✓", m); const bad = (m) => { console.log("  ✗", m); failed++; };
function pos(red, green, die) {
  const room = { cfg: buildConfig(["red", "green"], 4), players: [{ color: "red" }, { color: "green" }], turn: 0, die, teamMode: false, teamOf: null, tokens: { red, green } };
  return { room, lm: legalMoves(room) };
}
const pick = (red, green, die) => { const { room, lm } = pos(red, green, die); return botPick(room, lm); };
// 1. capture beats a plain advance, and the enemy furthest along is preferred
// red 20→25 would capture green p=12 (abs 25); red 30→35 captures green p=22 (abs 35): both captures, take the further enemy
{ const r = pick([20, 30, -1, -1], [12, 22, -1, -1], 5); r === 1 ? ok("capture: takes the capture of the enemy furthest along (token 1)") : bad("capture: picked token " + r); }
{ const r = pick([20, 3, -1, -1], [11, -1, -1, -1], 4); r === 0 ? ok("capture: prefers the capturing move over a quiet advance") : bad("capture: picked token " + r); }
// 2. exact finish
{ const r = pick([53, 10, -1, -1], [-1, -1, -1, -1], 3); r === 0 ? ok("finish: takes the exact finish (53+3=56)") : bad("finish: picked token " + r); }
// 3. rescue: red token 0 at 5 is threatened by green at abs 2 (green p=41); 5+3 = 8 is safe. Token 1 is further along but not in danger.
{ const r = pick([5, 30, -1, -1], [41, -1, -1, -1], 3); r === 0 ? ok("rescue: moves the threatened token onto the safe cell instead of advancing the furthest token") : bad("rescue: picked token " + r); }
// 4. out on a six beats a safe landing (20+6=26 is safe)
{ const r = pick([-1, 20, -1, -1], [-1, -1, -1, -1], 6); r === 0 ? ok("six: brings a token out before landing safe") : bad("six: picked token " + r); }
// 5. safe landing beats advancing the furthest token (16+5=21 safe; 40+5=45 open)
{ const r = pick([16, 40, -1, -1], [-1, -1, -1, -1], 5); r === 0 ? ok("safe: lands on the safe cell rather than pushing the furthest token") : bad("safe: picked token " + r); }
// 6. never leave a safe cell into a threatened one when a calmer move exists: red 8 (safe) → 10 with green at abs 6 (p=45) behind; red 30 → 32 is calm
{ const r = pick([8, 30, -1, -1], [45, -1, -1, -1], 2); r === 1 ? ok("risk: keeps the safe token home and moves the calm one") : bad("risk: picked token " + r); }
// 6b. track before lane when both calm (52 is in the lane): red 52→54 vs red 20→22
{ const r = pick([52, 20, -1, -1], [-1, -1, -1, -1], 2); r === 1 ? ok("advance: track token before lane token") : bad("advance: picked token " + r); }
// 6c. ...but a lane move beats a threatened track move: red 20→22 with green at abs 18 (p=5) behind
{ const r = pick([52, 20, -1, -1], [5, -1, -1, -1], 2); r === 0 ? ok("advance: lane move beats stepping into a threatened cell") : bad("advance: picked token " + r); }
// team mode: a partner's token is never captured (red+green partners, blue enemy)
{ const room = { cfg: buildConfig(["red", "green", "yellow", "blue"], 4), players: [{ color: "red" }, { color: "green" }, { color: "yellow" }, { color: "blue" }], turn: 0, die: 4, teamMode: true, teamOf: [0, 0, 1, 1],
    tokens: { red: [20, 3, -1, -1], green: [11, -1, -1, -1], yellow: [-1, -1, -1, -1], blue: [-1, -1, -1, -1] } };
  const r = botPick(room, legalMoves(room)); r === 0 ? ok("team: partner on the landing cell is not treated as a capture (still the furthest calm move)") : bad("team: picked token " + r);
  room.tokens.blue = [45, -1, -1, -1]; // blue p=45 → abs 39+45=84%52=32; red 30→34? make red token 1 at 28: 28+4=32 captures blue
  room.tokens.red = [20, 28, -1, -1]; const r2 = botPick(room, legalMoves(room)); r2 === 1 ? ok("team: enemy token is captured") : bad("team: picked token " + r2); }
console.log(failed ? `\n=== LUDO RULES: FAIL (${failed}) ===` : "\n=== LUDO RULES: PASS ===");
process.exit(failed ? 1 : 0);
