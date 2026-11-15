/* Power mode (2026-11-13): every rule of it, proved twice over.
   Part 1 is in-process (scripted tables, no port): the shield, the extra step, the re-roll, the caps, Classic, the hold, the bots.
   Part 2 starts its own server (TEST_HOOKS=1, fast clocks) and talks to it as the app does: who may host, the stock and who
   sees it, the one message and the one broadcast, old apps, a reconnect, the hold's clock, a timeout, quick play.
   Run from the repo root: node test/power.js   (TEST_PORT2 picks the port) */
const assert = require("assert");
const { spawn } = require("child_process");
const { io } = require("socket.io-client");
process.env.BOT_DELAY_MS = "5";
process.env.POWER_HOLD_MS = "600";
const S = require("../server.js");
const PORT = Number(process.env.TEST_PORT2 || 3142), BASE = `http://localhost:${PORT}`;
if (PORT >= 3111 && PORT <= 3126) { console.error("refusing " + PORT + ": a live server's port"); process.exit(2); }
const HOLD_MS = Number(process.env.POWER_HOLD_MS), TURN_MS = 2500;
let passed = 0, failed = 0;
const ok = async (name, fn) => { try { await fn(); passed++; console.log("  ok " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n      " + ((e && e.message) || e)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000, step = 15) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };

/* ---------- part 1: scripted tables ---------- */
let nTable = 0;
function table(o = {}) {
  const seat = (id, color, stock, bot) => Object.assign({ id, name: id, color, left: false, connected: true, pw: S.Power.seat(bot ? null : ["power"], stock || null) }, bot ? { bot: true } : {});
  const room = { code: "PWT" + (++nTable), mode: o.mode || "power", cfg: S.buildConfig(["red", "green"], 4), host: "Ava",
    players: [seat("Ava", "red", o.red, o.redBot), seat("Ben", "green", o.green, o.greenBot)],
    turn: o.turn || 0, phase: o.phase || "roll", die: o.die === undefined ? null : o.die, sixes: 0, teamMode: false, teamOf: null,
    tokens: { red: (o.r || [-1, -1, -1, -1]).slice(), green: (o.g || [-1, -1, -1, -1]).slice() }, status: "playing", v: 1, log: "", lastMove: null, testDice: (o.dice || []).slice() };
  S.setupPower(room);
  S.rooms.set(room.code, room);
  return room;
}
const quiet = () => { for (const m of [S.timers, S.botTimers, S.botWatches]) { for (const t of m.values()) clearTimeout(t); m.clear(); } };
const FULL = { shield: 5, step: 5, reroll: 5 };

async function part1() {
  console.log("ludo power: the rules (scripted tables)");

  await ok("shield: one pawn on the track takes it without a second tap, and the ring is in the state", () => {
    const room = table({ red: FULL, r: [20, -1, -1, -1] });
    assert.strictEqual(S.usePower(room, "shield"), null);
    assert.strictEqual(room.pw.shield.red, 0);
    const view = S.powerView(room);
    assert.strictEqual(view.mode, "power");
    assert.strictEqual(view.power.seats[0].shield, 0);
    assert.strictEqual(view.power.seats[0].used, 1);
    assert.deepStrictEqual(view.power.last, { id: 1, seat: 0, kind: "shield", i: 0 });
    assert.strictEqual(room.players[0].pw.stock.shield, 4);
    assert.strictEqual(room.players[0].pw.left, 2);
  });
  await ok("shield: two pawns on the track need the pawn named; a yard pawn, a home-lane pawn and a finished one cannot take it", () => {
    const room = table({ red: FULL, r: [20, 30, -1, 52] });
    assert.deepStrictEqual(S.powerCan(room, 0).shield, [0, 1]);
    assert.strictEqual(S.usePower(room, "shield"), "Pick a pawn on the track.");
    assert.strictEqual(S.usePower(room, "shield", 2), "Pick a pawn on the track.");
    assert.strictEqual(S.usePower(room, "shield", 3), "Pick a pawn on the track.");
    assert.strictEqual(room.players[0].pw.left, 3, "a refused use spends nothing");
    assert.strictEqual(S.usePower(room, "shield", 1), null);
    assert.strictEqual(room.pw.shield.red, 1);
  });
  await ok("shield: no pawn on the track, no shield", () => {
    const room = table({ red: FULL });
    assert.strictEqual(S.usePower(room, "shield"), "No pawn on the track to shield.");
  });
  await ok("shield: one shielded pawn at a time for a player", () => {
    const room = table({ red: FULL, r: [20, 30, -1, -1] });
    assert.strictEqual(S.usePower(room, "shield", 0), null);
    room.pw.turnUsed = false;   // the next turn
    assert.strictEqual(S.usePower(room, "shield", 1), "One shielded pawn at a time.");
    assert.strictEqual(room.players[0].pw.spent.shield, 1);
  });
  await ok("shield: it blocks one capture (the attacker lands, both share the square, the shield pops, no extra roll), then the next capture is real", () => {
    // red's pawn 0 on cell 20; green starts at 13, so green's pawn at 4 is on cell 17 and a 3 lands on it
    const room = table({ red: FULL, r: [20, -1, -1, -1], g: [4, -1, -1, -1], turn: 1, phase: "move", die: 3 });
    room.pw.shield.red = 0;
    S.performMove(room, 0);
    assert.deepStrictEqual(room.tokens.red, [20, -1, -1, -1], "the shielded pawn stays");
    assert.strictEqual(room.tokens.green[0], 7, "the attacker landed");
    assert.deepStrictEqual(room.lastMove.captured, []);
    assert.deepStrictEqual(room.lastMove.blocked, [{ c: "red", i: 0 }]);
    assert.strictEqual(room.pw.shield.red, -1, "the shield popped");
    assert.strictEqual(room.turn, 0, "a blocked capture earns no extra roll");
    assert.match(room.log, /^Blocked! Ava's shield held\./);
    // the same landing again, no shield now
    room.tokens.green = [4, -1, -1, -1]; room.turn = 1; room.phase = "move"; room.die = 3;
    S.performMove(room, 0);
    assert.deepStrictEqual(room.tokens.red, [-1, -1, -1, -1]);
    assert.strictEqual(room.lastMove.blocked, undefined);
    assert.strictEqual(room.lastMove.captured.length, 1);
    assert.strictEqual(room.turn, 1, "a real capture rolls again");
  });
  await ok("shield: a stack with one shielded pawn loses the others", () => {
    const room = table({ red: FULL, r: [20, 20, -1, -1], g: [4, -1, -1, -1], turn: 1, phase: "move", die: 3 });
    room.pw.shield.red = 1;
    S.performMove(room, 0);
    assert.deepStrictEqual(room.tokens.red, [-1, 20, -1, -1]);
    assert.deepStrictEqual(room.lastMove.blocked, [{ c: "red", i: 1 }]);
    assert.deepStrictEqual(room.lastMove.captured.map((x) => x.i), [0]);
    assert.strictEqual(room.turn, 1, "the capture that happened rolls again");
  });
  await ok("shield: a shielded pawn that leaves the shared track (its home lane, or home) keeps nothing", () => {
    const room = table({ red: FULL, r: [49, 10, -1, -1], phase: "move", die: 3 });
    room.pw.shield.red = 0;
    S.performMove(room, 0);
    assert.strictEqual(room.tokens.red[0], 52);
    assert.strictEqual(room.pw.shield.red, -1);
    const home = table({ red: FULL, r: [50, 10, -1, -1], phase: "move", die: 6 });
    home.pw.shield.red = 1;
    S.performMove(home, 1);
    assert.strictEqual(home.pw.shield.red, 1, "a pawn still on the track keeps its ring");
  });

  await ok("extra step: the move is the roll plus one for a pawn on the track, and never for one in the yard", () => {
    const room = table({ red: FULL, r: [10, -1, -1, -1], phase: "move", die: 6 });
    assert.deepStrictEqual(S.legalMoves(room), [0, 1, 2, 3]);
    assert.strictEqual(S.powerCan(room, 0).step, true);
    assert.strictEqual(S.usePower(room, "step"), null);
    assert.strictEqual(S.powerView(room).power.step, true);
    assert.deepStrictEqual(S.legalMoves(room), [0], "the yard pawns are out of it");
    S.performMove(room, 1);
    assert.strictEqual(room.tokens.red[1], -1, "a yard pawn does not move on an extra step");
    S.performMove(room, 0);
    assert.strictEqual(room.tokens.red[0], 17);
    assert.strictEqual(room.lastMove.step, true);
    assert.strictEqual(room.lastMove.to, 17);
    assert.strictEqual(room.pw.step, false, "it is for one move");
    assert.strictEqual(room.turn, 0, "the die was a six: roll again");
    assert.strictEqual(room.phase, "roll");
  });
  await ok("extra step: a five plus one moves six and does NOT roll again (the six rule looks at the die only)", () => {
    const room = table({ red: FULL, r: [10, -1, -1, -1], phase: "move", die: 5 });
    assert.strictEqual(S.usePower(room, "step"), null);
    S.performMove(room, 0);
    assert.strictEqual(room.tokens.red[0], 16);
    assert.strictEqual(room.turn, 1);
  });
  await ok("extra step: the key is live only when some pawn can legally move roll+1", () => {
    assert.strictEqual(S.powerCan(table({ red: FULL, phase: "move", die: 6 }), 0).step, false, "only yard pawns");
    assert.strictEqual(S.usePower(table({ red: FULL, phase: "move", die: 6 }), "step"), "No pawn can move one more.");
    assert.strictEqual(S.powerCan(table({ red: FULL, r: [54, -1, -1, -1], phase: "move", die: 2 }), 0).step, false, "roll+1 overshoots home");
    assert.strictEqual(S.powerCan(table({ red: FULL, r: [53, -1, -1, -1], phase: "move", die: 2 }), 0).step, true, "roll+1 is the exact finish");
    assert.strictEqual(S.powerCan(table({ red: FULL, r: [10, -1, -1, -1], phase: "roll" }), 0).step, false, "before the roll");
    assert.strictEqual(S.usePower(table({ red: FULL, r: [10, -1, -1, -1], phase: "roll" }), "step"), "Roll first.");
  });
  await ok("extra step: the plus-one square captures like any landing", () => {
    const room = table({ red: FULL, r: [3, -1, -1, -1], g: [44, -1, -1, -1], phase: "move", die: 1 });   // green's 44 is cell 5; red 3 + 1 + 1 = 5
    assert.strictEqual(S.usePower(room, "step"), null);
    S.performMove(room, 0);
    assert.strictEqual(room.tokens.green[0], -1);
    assert.strictEqual(room.lastMove.captured.length, 1);
  });

  await ok("re-roll: the roll is thrown away and rolled again, and a thrown-away six does not count", () => {
    const room = table({ red: FULL, r: [10, -1, -1, -1], dice: [6, 6, 2] });
    S.performRoll(room);
    assert.strictEqual(room.die, 6); assert.strictEqual(room.sixes, 1);
    assert.strictEqual(S.powerCan(room, 0).reroll, true);
    assert.strictEqual(S.usePower(room, "reroll"), null);
    assert.strictEqual(room.die, 6); assert.strictEqual(room.sixes, 1, "one six, not two");
    assert.strictEqual(room.phase, "move");
    assert.strictEqual(room.players[0].pw.spent.reroll, 1);
    assert.strictEqual(S.usePower(room, "reroll"), "One power-up a turn.");
  });
  await ok("re-roll: only after the roll", () => {
    const room = table({ red: FULL, r: [10, -1, -1, -1] });
    assert.strictEqual(S.powerCan(room, 0).reroll, false);
    assert.strictEqual(S.usePower(room, "reroll"), "Roll first.");
  });

  await ok("the caps: one power-up a turn (a six's bonus roll is the same turn), three a game", () => {
    const room = table({ red: FULL, r: [10, 20, -1, -1], dice: [6, 2, 3, 3, 3] });
    assert.strictEqual(S.usePower(room, "shield", 0), null);
    S.performRoll(room);                                    // a six
    assert.strictEqual(S.usePower(room, "step"), "One power-up a turn.");
    S.performMove(room, 1);                                 // the bonus roll is still this turn
    assert.strictEqual(room.turn, 0);
    S.performRoll(room);
    assert.strictEqual(S.usePower(room, "reroll"), "One power-up a turn.");
    S.performMove(room, 1);
    assert.strictEqual(room.turn, 1);
    room.turn = 0; room.phase = "roll"; room.die = null; room.pw.turnUsed = false;
    S.performRoll(room);
    assert.strictEqual(S.usePower(room, "step"), null);     // 2
    S.performMove(room, 1);
    room.turn = 0; room.phase = "roll"; room.die = null; room.pw.turnUsed = false;
    S.performRoll(room);
    assert.strictEqual(S.usePower(room, "reroll"), null);   // 3
    assert.strictEqual(room.players[0].pw.left, 0);
    S.performMove(room, 1);
    room.turn = 0; room.phase = "roll"; room.die = null; room.pw.turnUsed = false;
    assert.strictEqual(S.usePower(room, "shield", 1), "No uses left this game.");
    assert.deepStrictEqual(S.powerCan(room, 0), { shield: [], step: false, reroll: false });
    assert.strictEqual(S.powerView(room).power.seats[0].used, 3);
    assert.strictEqual(S.powerView(room).power.max, 3);
  });
  await ok("the stock: none owned, none used; and it is the other seat's turn's business only on their turn", () => {
    const room = table({ red: { shield: 0, step: 1, reroll: 0 }, green: FULL, r: [10, -1, -1, -1], g: [10, -1, -1, -1] });
    assert.strictEqual(S.usePower(room, "shield"), "You have none of those.");
    assert.strictEqual(S.usePower(room, "nonsense"), "No such power-up.");
    assert.strictEqual(room.players[1].pw.stock.shield, 5, "the seat whose turn it is not spends nothing");
    assert.deepStrictEqual(S.powerCan(room, 1), { shield: [], step: false, reroll: false });
  });
  await ok("a Classic room never takes a power-up, and its state says nothing of them", () => {
    const room = table({ mode: "classic", red: FULL, r: [10, -1, -1, -1], phase: "move", die: 3 });
    assert.strictEqual(room.pw, null);
    for (const k of ["shield", "step", "reroll"]) assert.strictEqual(S.usePower(room, k), "Power-ups are for Power rooms.");
    assert.deepStrictEqual(S.powerView(room), { mode: "classic" });
    assert.deepStrictEqual(S.legalMoves(room), [0]);
    S.performMove(room, 0);
    assert.deepStrictEqual(room.lastMove, { color: "red", i: 0, from: 10, to: 13, captured: [], mv: room.lastMove.mv }, "a Classic move is the move it always was");
    assert.strictEqual(room.players[0].pw.stock.shield, 5);
  });

  await ok("the hold: a dead roll waits for a player who owns a re-roll, and the re-roll plays on", () => {
    const room = table({ red: FULL, dice: [3, 6] });
    S.performRoll(room);
    assert.strictEqual(room.turn, 0); assert.strictEqual(room.phase, "move"); assert.strictEqual(room.die, 3);
    assert.ok(room.pw.hold > Date.now() && room.pw.hold <= Date.now() + 4000, "up to 4 s");
    assert.strictEqual(room.turnEndsAt, room.pw.hold, "the clock the app shows is the hold's");
    assert.deepStrictEqual(S.powerCan(room, 0), { shield: [], step: false, reroll: true });
    assert.strictEqual(S.usePower(room, "reroll"), null);
    assert.strictEqual(room.pw.hold, null);
    assert.strictEqual(room.die, 6); assert.strictEqual(room.phase, "move"); assert.strictEqual(room.turn, 0);
    quiet();
  });
  await ok("the hold: not without a re-roll, not with no uses left, not after a power-up this turn, not for an empty seat, not on an auto-played turn", () => {
    const dead = (o, opts, prep) => { const room = table(Object.assign({ dice: [3] }, o)); if (prep) prep(room); S.performRoll(room, opts); quiet(); return room; };
    assert.strictEqual(dead({ red: { shield: 5, step: 5, reroll: 0 } }).turn, 1, "no re-roll owned");
    assert.strictEqual(dead({ red: FULL }, null, (r) => { r.players[0].pw.left = 0; }).turn, 1, "no uses left");
    assert.strictEqual(dead({ red: FULL }, null, (r) => { r.pw.turnUsed = true; }).turn, 1, "one already used this turn");
    assert.strictEqual(dead({ red: FULL }, null, (r) => { r.players[0].connected = false; }).turn, 1, "the player is away");
    assert.strictEqual(dead({ red: FULL }, null, (r) => { r.players[0].botControlled = true; }).turn, 1, "a bot plays the seat");
    assert.strictEqual(dead({ red: FULL }, { auto: true }).turn, 1, "an auto-played turn");
    assert.strictEqual(dead({ red: FULL, mode: "classic" }).turn, 1, "a Classic room");
    const six = dead({ red: FULL, dice: [6] }, null, (r) => { r.tokens.red = [56, 56, 56, 55]; });
    assert.strictEqual(six.pw.hold, null, "a six with no move rolls again as ever");
    assert.strictEqual(six.phase, "roll");
  });
  await ok("the hold: untouched, the turn passes when it ends, nothing is spent and no timeout is counted", () => {
    const room = table({ red: FULL, dice: [3] });
    S.performRoll(room);
    assert.ok(room.pw.hold);
    S.endHold(room.code);
    assert.strictEqual(room.turn, 1);
    assert.strictEqual(room.phase, "roll");
    assert.strictEqual(room.pw.hold, null);
    assert.deepStrictEqual(room.players[0].pw.spent, { shield: 0, step: 0, reroll: 0 });
    assert.strictEqual(room.players[0].timeouts || 0, 0);
    quiet();
  });

  await ok("bots: each gets the rounded mean of the humans' usable counts, and none when no human owns any", () => {
    const B = S.Power.botUses, seat = (st) => S.Power.seat(["power"], st);
    assert.strictEqual(B([seat({ shield: 9, step: 9, reroll: 9 })]), 3, "the smaller of 3 and what they own");
    assert.strictEqual(B([seat({ shield: 1 }), seat({ reroll: 2 })]), 2, "(1 + 2) / 2 rounds to 2");
    assert.strictEqual(B([seat({ shield: 2 }), seat(null)]), 1);
    assert.strictEqual(B([seat({ shield: 1 }), seat(null), seat(null)]), 0, "a third rounds to none");
    assert.strictEqual(B([seat(null), seat(null)]), 0);
    assert.strictEqual(B([S.Power.seat(null, { shield: 9 })]), 0, "an old app owns nothing here");
    const room = table({ red: { shield: 1, step: 1, reroll: 0 }, greenBot: true });
    assert.strictEqual(room.players[1].pw.left, 2);
    assert.deepStrictEqual(room.players[1].pw.stock, { shield: 2, step: 2, reroll: 2 });
    const none = table({ greenBot: true });
    assert.strictEqual(none.players[1].pw.left, 0);
    assert.strictEqual(S.usePower(Object.assign(none, { turn: 1, phase: "move", die: 3, tokens: { red: [-1, -1, -1, -1], green: [10, -1, -1, -1] } }), "shield"), "No uses left this game.");
  });
  await ok("bots: a dead roll held is re-rolled", () => {
    const room = table({ red: FULL, greenBot: true, turn: 1, dice: [3, 6] });
    S.performRoll(room);
    assert.ok(room.pw.hold, "held for the bot too");
    S.botAction(room);
    assert.strictEqual(room.players[1].pw.spent.reroll, 1);
    assert.strictEqual(room.die, 6);
    quiet();
  });
  await ok("bots: the extra step is used when it captures and the roll alone does not", () => {
    // green's pawn at 4 is on cell 17; red on cell 21 is safe, so put red's pawn on 22 (pos 22): green needs 5, rolls 4
    const room = table({ red: FULL, greenBot: true, r: [22, -1, -1, -1], g: [4, -1, -1, -1], turn: 1, phase: "move", die: 4 });
    assert.strictEqual(S.botPower(room), true);
    assert.strictEqual(room.players[1].pw.spent.step, 1);
    S.botAction(room);
    assert.strictEqual(room.tokens.red[0], -1, "and the capture is made");
    quiet();
  });
  await ok("bots: the shield goes on the pawn an enemy can reach; a bot with nothing to fear keeps it", () => {
    // green's pawn will stand on cell 13+20+2 = 35 after its 2; red's pawn on cell 31 is 4 behind it
    const room = table({ red: FULL, greenBot: true, r: [31, -1, -1, -1], g: [20, -1, -1, -1], turn: 1, phase: "move", die: 2 });
    assert.strictEqual(S.botPower(room), true);
    assert.strictEqual(room.pw.shield.green, 0);
    assert.strictEqual(room.players[1].pw.spent.shield, 1);
    const calm = table({ red: FULL, greenBot: true, r: [-1, -1, -1, -1], g: [20, -1, -1, -1], turn: 1, phase: "move", die: 2 });
    assert.strictEqual(S.botPower(calm), false);
    assert.strictEqual(S.Power.used(calm.players[1].pw), 0);
    quiet();
  });
  await ok("bots: a seat a bot plays for a timed-out person never spends that person's power-ups", () => {
    const room = table({ red: FULL, green: FULL, r: [31, -1, -1, -1], g: [20, -1, -1, -1], turn: 1, phase: "move", die: 2 });
    room.players[1].botControlled = true;
    assert.strictEqual(S.botPower(room), false);
    S.botAction(room);
    assert.deepStrictEqual(room.players[1].pw.spent, { shield: 0, step: 0, reroll: 0 });
    assert.deepStrictEqual(room.players[1].pw.stock, FULL);
    quiet();
  });
  await ok("a new game: every use back, no ring, a new game id; the stock stays what was left", () => {
    const room = table({ red: FULL, r: [20, -1, -1, -1] });
    S.usePower(room, "shield");
    const game = room.pw.game;
    S.setupPower(room);
    assert.notStrictEqual(room.pw.game, game);
    assert.strictEqual(room.pw.shield.red, -1);
    assert.strictEqual(room.players[0].pw.left, 3);
    assert.deepStrictEqual(room.players[0].pw.spent, { shield: 0, step: 0, reroll: 0 });
    assert.strictEqual(room.players[0].pw.stock.shield, 4);
    assert.strictEqual(room.pw.seq, 1, "the uses' ids keep counting");
  });
  await ok("the stock an app sends: clamped 0..99, whole numbers only, and a use it has not counted yet is not counted twice", () => {
    const P = S.Power;
    assert.deepStrictEqual(P.seat(["power"], { shield: 500, step: -3, reroll: 2.5, bogus: 7 }).stock, { shield: 99, step: 0, reroll: 0 });
    assert.deepStrictEqual(P.seat(["waitList"], { shield: 5 }).stock, { shield: 0, step: 0, reroll: 0 }, "an app that does not know the mode owns nothing");
    const pw = P.seat(["power"], { shield: 3, step: 0, reroll: 0 });
    P.spend(pw, "shield");                                                  // the server holds 2, spent 1
    P.take(pw, { shield: 3, step: 0, reroll: 0 }, "g1");                    // the phone has not counted the use
    assert.strictEqual(pw.stock.shield, 2);
    P.take(pw, { shield: 2, step: 0, reroll: 0, seen: { game: "g1", shield: 1 } }, "g1");   // now it has
    assert.strictEqual(pw.stock.shield, 2);
    P.take(pw, { shield: 7, step: 0, reroll: 0, seen: { game: "g1", shield: 1 } }, "g1");   // and bought a pack
    assert.strictEqual(pw.stock.shield, 7);
    P.take(pw, { shield: 7, step: 0, reroll: 0, seen: { game: "another", shield: 1 } }, "g1");   // another game's count is not this one's
    assert.strictEqual(pw.stock.shield, 6);
  });
  quiet();
  for (const code of [...S.rooms.keys()]) if (code.startsWith("PWT")) S.rooms.delete(code);
}

/* ---------- part 2: the app's side of the wire ---------- */
function client(name, extra) {
  const s = io(BASE, { transports: ["websocket"], reconnection: false });
  const p = { name, s, seat: -1, state: null, id: name + "-" + Math.random().toString(36).slice(2, 8), joinedCode: null, refusals: [], used: [], extra: extra || {} };
  s.on("state", ({ room, mySeat }) => { p.seat = mySeat; p.state = room; });
  s.on("joined", (j) => { p.joinedCode = j.code; });
  s.on("refusal", (r) => p.refusals.push(r));
  s.on("powerUsed", (u) => p.used.push(u));
  return p;
}
const connected = (p) => new Promise((r) => (p.s.connected ? r() : p.s.once("connect", r)));
const NEW = { caps: ["waitList", "power"] }, OLD = { caps: ["waitList"] };
const ident = (p) => Object.assign({ name: p.name, playerId: p.id, avatar: "\u{1F98A}" }, p.extra);

/* A started two-seat Power game: A hosts (seat 0), B is the guest. */
async function game(aExtra, bExtra, mode = "power") {
  const A = client("Ava", aExtra), B = client("Ben", bExtra); await connected(A); await connected(B);
  A.s.emit("create", ident(A)); await until(() => A.joinedCode);
  B.s.emit("join", Object.assign({ code: A.joinedCode }, ident(B))); await until(() => B.state && B.state.players.length === 2);
  A.s.emit("settings", { tokens: 2, mode }); await until(() => A.state && A.state.tokenChoice === 2 && A.state.mode === mode);
  A.s.emit("start"); await until(() => A.state && A.state.status === "playing" && B.state.status === "playing");
  return { A, B, code: A.joinedCode, cA: A.state.players[0].color, cB: A.state.players[1].color };
}
const stage = async (p, o) => { const v = p.state.v; p.s.emit("__test", o); await until(() => p.state.v > v); };
const bye = (...ps) => ps.forEach((p) => p.s.disconnect());

async function part2() {
  console.log("ludo power: the wire (its own server)");
  const srv = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT: String(PORT), TEST_HOOKS: "1", POWER_HOLD_MS: String(HOLD_MS), TURN_MS: String(TURN_MS), BOT_DELAY_MS: "5", QUICK_FILL_MS: "4000", QUICK_FILL_MAX_MS: "6000" }, stdio: "ignore" });
  await sleep(700);
  try {
    await ok("hosting: an app that does not know Power mode cannot host one; one that does can, and the guest sees it", async () => {
      const A = client("Ava", OLD), B = client("Ben", NEW); await connected(A); await connected(B);
      A.s.emit("create", ident(A)); await until(() => A.joinedCode);
      B.s.emit("join", Object.assign({ code: A.joinedCode }, ident(B))); await until(() => B.state && B.state.players.length === 2);
      assert.strictEqual(A.state.mode, "classic", "the state always names the mode");
      A.s.emit("settings", { mode: "power" });
      assert.ok(await until(() => A.refusals.length === 1), "refused");
      assert.deepStrictEqual(A.refusals[0], { code: "power", message: "Update GameNest to play Power mode.", op: "settings" });
      assert.strictEqual(A.state.mode, "classic");
      B.s.emit("settings", { mode: "power" });   // the guest is not the host
      await sleep(120);
      assert.strictEqual(B.state.mode, "classic");
      bye(A, B);
      const H = client("Hal", NEW), G = client("Gus", OLD); await connected(H); await connected(G);
      H.s.emit("create", ident(H)); await until(() => H.joinedCode);
      G.s.emit("join", Object.assign({ code: H.joinedCode }, ident(G))); await until(() => G.state && G.state.players.length === 2);
      H.s.emit("settings", { mode: "power" });
      assert.ok(await until(() => G.state.mode === "power" && H.state.mode === "power"));
      assert.strictEqual(H.state.power.max, 3);
      assert.strictEqual(H.state.power.game, null, "no game yet");
      H.s.emit("settings", { mode: "nonsense" }); await sleep(80);
      assert.strictEqual(H.state.mode, "power");
      H.s.emit("settings", { mode: "classic" });
      assert.ok(await until(() => G.state.mode === "classic" && G.state.power === undefined));
      // a Power lobby whose host leaves it to an older app is a Classic lobby again
      H.s.emit("settings", { mode: "power" }); await until(() => G.state.mode === "power");
      H.s.emit("leave");
      assert.ok(await until(() => G.state.players.length === 1 && G.state.mode === "classic"), "the older app never hosts a Power room");
      bye(H, G);
    });

    await ok("the mode is the lobby's: it cannot change once the game is on", async () => {
      const { A, B } = await game(NEW, NEW, "classic");
      A.s.emit("settings", { mode: "power" }); await sleep(150);
      assert.strictEqual(A.state.mode, "classic");
      assert.strictEqual(A.state.power, undefined);
      bye(A, B);
    });

    await ok("a Classic room refuses a power-up, whatever the app sends", async () => {
      const { A, B, cA } = await game({ caps: NEW.caps, power: { shield: 5, step: 5, reroll: 5 } }, NEW, "classic");
      await stage(A, { tokens: { [cA]: [20, -1] }, dice: [3] });
      const before = JSON.stringify(A.state.tokens);
      A.s.emit("power", { kind: "shield", i: 0 });
      assert.ok(await until(() => A.refusals.length === 1));
      assert.deepStrictEqual(A.refusals[0], { code: "power", message: "Power-ups are for Power rooms.", op: "power" });
      A.s.emit("roll"); await until(() => A.state.phase === "move");
      A.s.emit("power", { kind: "step" }); A.s.emit("power", { kind: "reroll" });
      assert.ok(await until(() => A.refusals.length === 3));
      assert.strictEqual(A.state.die, 3);
      assert.strictEqual(JSON.stringify(A.state.tokens), before);
      assert.strictEqual(A.used.length + B.used.length, 0);
      assert.strictEqual(A.state.power, undefined);
      bye(A, B);
    });

    await ok("the stock: clamped, and each player is told their own alone", async () => {
      const { A, B } = await game({ caps: NEW.caps, power: { shield: 500, step: -3, reroll: 2 } }, { caps: NEW.caps, power: { shield: 1, step: 1, reroll: 1 } });
      assert.deepStrictEqual(A.state.power.me.stock, { shield: 99, step: 0, reroll: 2 });
      assert.deepStrictEqual(B.state.power.me.stock, { shield: 1, step: 1, reroll: 1 });
      assert.strictEqual(A.state.power.me.left, 3);
      assert.ok(/^[0-9a-f]{8}$/.test(A.state.power.game));
      for (const seat of A.state.power.seats) assert.deepStrictEqual(Object.keys(seat).sort(), ["shield", "used"], "a seat shows its ring and its uses, never a stock");
      assert.ok(!JSON.stringify(Object.assign({}, B.state, { power: Object.assign({}, B.state.power, { me: null }) })).includes("99"), "nothing of Ava's stock reaches Ben");
      assert.ok(!JSON.stringify(A.state.players).includes("stock"));
      bye(A, B);
    });

    await ok("a use end to end: one message, one broadcast to everyone, the ring and the uses in everyone's state; then the block", async () => {
      const { A, B, cA, cB } = await game({ caps: NEW.caps, power: { shield: 3, step: 0, reroll: 0 } }, NEW);
      const sA = A.state.cfg.starts[cA], sB = A.state.cfg.starts[cB];
      const cell = (sA + 20) % 52, pB = (cell - 3 - sB + 104) % 52;
      assert.ok(pB + 3 <= 50, "the staged attacker stays on the track");
      await stage(A, { tokens: { [cA]: [19, -1], [cB]: [pB, -1] }, dice: [1, 3] });
      assert.deepStrictEqual(A.state.power.me.can, { shield: [0], step: false, reroll: false });
      A.s.emit("power", { kind: "shield" });
      assert.ok(await until(() => A.used.length === 1 && B.used.length === 1), "everyone hears it");
      assert.deepStrictEqual(B.used[0], { id: 1, seat: 0, kind: "shield", i: 0 });
      assert.ok(await until(() => B.state.power.seats[0].shield === 0 && B.state.power.seats[0].used === 1));
      assert.deepStrictEqual(B.state.power.last, { id: 1, seat: 0, kind: "shield", i: 0 });
      assert.deepStrictEqual(A.state.power.me.stock, { shield: 2, step: 0, reroll: 0 });
      assert.deepStrictEqual(A.state.power.me.spent, { shield: 1, step: 0, reroll: 0 });
      assert.strictEqual(A.state.power.me.left, 2);
      assert.strictEqual(A.state.power.me.used, undefined);
      A.s.emit("power", { kind: "shield", i: 0 });
      assert.ok(await until(() => A.refusals.length === 1));
      assert.strictEqual(A.refusals[0].message, "One power-up a turn.");
      B.s.emit("power", { kind: "shield" });
      assert.ok(await until(() => B.refusals.length === 1));
      assert.strictEqual(B.refusals[0].message, "Wait for your turn.");
      A.s.emit("roll"); await until(() => A.state.phase === "move" && A.state.die === 1);
      A.s.emit("move", { i: 0 }); await until(() => B.state.turn === 1);
      assert.strictEqual(B.state.power.seats[0].shield, 0, "the ring moves with the pawn");
      B.s.emit("roll"); await until(() => B.state.phase === "move" && B.state.die === 3);
      B.s.emit("move", { i: 0 });
      assert.ok(await until(() => A.state.lastMove && A.state.lastMove.color === cB));
      assert.deepStrictEqual(A.state.lastMove.blocked, [{ c: cA, i: 0 }]);
      assert.deepStrictEqual(A.state.lastMove.captured, []);
      assert.strictEqual(A.state.tokens[cA][0], 20);
      assert.strictEqual(A.state.tokens[cB][0], pB + 3);
      assert.strictEqual(A.state.power.seats[0].shield, -1);
      assert.strictEqual(A.state.turn, 0, "no extra roll for a blocked capture");
      bye(A, B);
    });

    await ok("the extra step and the re-roll over the wire, and a pack bought in the middle of the game is usable in it", async () => {
      const { A, B, cA } = await game({ caps: NEW.caps, power: { shield: 0, step: 1, reroll: 0 } }, NEW);
      await stage(A, { tokens: { [cA]: [10, -1] }, dice: [2, 4, 5] });
      A.s.emit("roll"); await until(() => A.state.phase === "move");
      assert.deepStrictEqual(A.state.power.me.can, { shield: [0], step: true, reroll: true });
      A.s.emit("power", { kind: "reroll" });
      assert.ok(await until(() => A.refusals.length === 1));
      assert.strictEqual(A.refusals[0].message, "You have none of those.");
      A.s.emit("powerStock", { shield: 0, step: 1, reroll: 5 });   // bought a pack of re-rolls
      assert.ok(await until(() => A.state.power.me.stock.reroll === 5));
      A.s.emit("power", { kind: "reroll" });
      assert.ok(await until(() => A.state.die === 4 && B.used.length === 1));
      assert.strictEqual(B.used[0].kind, "reroll");
      assert.strictEqual(A.state.power.me.stock.reroll, 4);
      A.s.emit("move", { i: 0 }); await until(() => A.state.turn === 1);
      assert.strictEqual(A.state.tokens[cA][0], 14);
      B.s.emit("roll"); await until(() => A.state.turn === 0 && A.state.phase === "roll");
      // (Ben's 5 with every pawn in the yard is a pass)
      await stage(A, { dice: [3] });
      A.s.emit("roll"); await until(() => A.state.phase === "move");
      A.s.emit("power", { kind: "step" });
      assert.ok(await until(() => A.state.power.step === true && B.used.length === 2));
      A.s.emit("move", { i: 0 });
      assert.ok(await until(() => B.state.lastMove && B.state.lastMove.step === true));
      assert.strictEqual(B.state.tokens[cA][0], 18);
      assert.strictEqual(B.state.power.step, false);
      assert.strictEqual(A.state.power.me.left, 1);
      bye(A, B);
    });

    await ok("the hold over the wire: a dead roll waits for the re-roll key; untouched, it passes when the hold ends and spends nothing", async () => {
      const { A, B } = await game({ caps: NEW.caps, power: { shield: 0, step: 0, reroll: 2 } }, NEW);
      await stage(A, { dice: [3, 6] });
      A.s.emit("roll");
      assert.ok(await until(() => A.state.phase === "move" && A.state.die === 3));
      assert.strictEqual(A.state.turn, 0);
      assert.ok(B.state.power.hold > 0, "everyone sees the hold");
      assert.strictEqual(A.state.turnEndsAt, A.state.power.hold);
      assert.deepStrictEqual(A.state.power.me.can, { shield: [], step: false, reroll: true });
      A.s.emit("power", { kind: "reroll" });
      assert.ok(await until(() => A.state.die === 6 && A.state.phase === "move" && A.state.power.hold === null));
      bye(A, B);
      const g = await game({ caps: NEW.caps, power: { shield: 0, step: 0, reroll: 2 } }, NEW);
      await stage(g.A, { dice: [4] });
      const t0 = Date.now();
      g.A.s.emit("roll");
      assert.ok(await until(() => g.A.state.phase === "move" && g.A.state.power.hold > 0));
      assert.ok(await until(() => g.A.state.turn === 1, HOLD_MS + 1500), "the turn passed");
      const dt = Date.now() - t0;
      assert.ok(dt >= HOLD_MS - 50 && dt < HOLD_MS + 900, `passed after ${dt} ms of a ${HOLD_MS} ms hold`);
      assert.deepStrictEqual(g.A.state.power.me.stock, { shield: 0, step: 0, reroll: 2 });
      assert.strictEqual(g.A.state.power.me.left, 3);
      assert.strictEqual(g.A.state.players[0].botControlled || false, false, "the hold running out is not a timeout");
      // and a player with no re-roll is not held at all
      await stage(g.A, { turn: 1, dice: [4] });
      const t1 = Date.now();
      g.B.s.emit("roll");
      assert.ok(await until(() => g.A.state.turn === 0, 1000));
      assert.ok(Date.now() - t1 < HOLD_MS - 100, "no wait without a re-roll");
      bye(g.A, g.B);
    });

    await ok("an old app joining a Power room by code is seated and plays without power-ups, and nothing it is sent is missing", async () => {
      const { A, B, cB } = await game({ caps: NEW.caps, power: { shield: 2, step: 2, reroll: 2 } }, { power: { shield: 9, step: 9, reroll: 9 } });   // Ben's app sends no caps at all
      assert.strictEqual(B.seat, 1);
      assert.strictEqual(B.state.mode, "power");
      assert.deepStrictEqual(B.state.power.me.stock, { shield: 0, step: 0, reroll: 0 }, "it owns nothing here, whatever it sends");
      for (const k of ["code", "status", "players", "turn", "phase", "die", "tokens", "cfg", "v", "log", "lastMove", "board"]) assert.ok(k in B.state, "the old field " + k);
      const keys = Object.keys(B.state);
      assert.ok(keys.indexOf("mode") > keys.indexOf("board") && keys.indexOf("power") > keys.indexOf("board"), "the new fields come after every older one");
      await stage(A, { turn: 1, tokens: { [cB]: [10, -1] }, dice: [2] });
      B.s.emit("power", { kind: "shield" });
      assert.ok(await until(() => B.refusals.length === 1));
      assert.strictEqual(B.refusals[0].message, "You have none of those.");
      B.s.emit("powerStock", { shield: 9, step: 9, reroll: 9 }); await sleep(100);
      assert.deepStrictEqual(B.state.power.me.stock, { shield: 0, step: 0, reroll: 0 });
      B.s.emit("roll"); await until(() => B.state.phase === "move" && B.state.die === 2);
      B.s.emit("move", { i: 0 });
      assert.ok(await until(() => B.state.tokens[cB][0] === 12), "it plays its turn as ever");
      assert.strictEqual(B.state.lastMove.blocked, undefined);
      assert.strictEqual(B.state.lastMove.step, undefined);
      bye(A, B);
    });

    await ok("a reconnect shows the ring and the uses left, and the stock is exact whether or not the phone had counted the use", async () => {
      const { A, B, cA, code } = await game({ caps: NEW.caps, power: { shield: 3, step: 0, reroll: 0 } }, NEW);
      await stage(A, { tokens: { [cA]: [20, -1] } });
      A.s.emit("power", { kind: "shield" });
      await until(() => A.state.power.me.left === 2);
      const gameId = A.state.power.game;
      A.s.disconnect(); await sleep(80);
      const A2 = client("Ava", {}); A2.id = A.id; await connected(A2);
      A2.s.emit("join", { code, name: "Ava", playerId: A.id, caps: NEW.caps, power: { shield: 3, step: 0, reroll: 0 } });   // the phone had not counted it
      assert.ok(await until(() => A2.state && A2.state.status === "playing"));
      assert.strictEqual(A2.seat, 0);
      assert.strictEqual(A2.state.power.seats[0].shield, 0, "the ring");
      assert.strictEqual(A2.state.power.seats[0].used, 1);
      assert.strictEqual(A2.state.power.me.left, 2, "the uses left");
      assert.deepStrictEqual(A2.state.power.me.spent, { shield: 1, step: 0, reroll: 0 });
      assert.strictEqual(A2.state.power.me.stock.shield, 2);
      assert.strictEqual(A2.state.power.game, gameId);
      assert.deepStrictEqual(A2.state.power.last, { id: 1, seat: 0, kind: "shield", i: 0 });
      A2.s.disconnect(); await sleep(80);
      const A3 = client("Ava", {}); A3.id = A.id; await connected(A3);
      A3.s.emit("join", { code, name: "Ava", playerId: A.id, caps: NEW.caps, power: { shield: 2, step: 0, reroll: 0, seen: { game: gameId, shield: 1 } } });   // now it had
      assert.ok(await until(() => A3.state && A3.state.status === "playing"));
      assert.strictEqual(A3.state.power.me.stock.shield, 2);
      assert.strictEqual(A3.state.power.me.left, 2);
      bye(A3, B);
    });

    await ok("a timeout: the turn is played for them and never spends a power-up", async () => {
      const { A, B, cA } = await game({ caps: NEW.caps, power: { shield: 3, step: 3, reroll: 3 } }, NEW);
      await stage(A, { tokens: { [cA]: [20, -1] }, dice: [2] });
      assert.ok(await until(() => B.state.turn === 1, TURN_MS + 1500), "the turn was played for them");
      assert.strictEqual(B.state.tokens[cA][0], 22);
      assert.deepStrictEqual(A.state.power.me.stock, { shield: 3, step: 3, reroll: 3 });
      assert.deepStrictEqual(A.state.power.me.spent, { shield: 0, step: 0, reroll: 0 });
      assert.strictEqual(A.state.power.seats[0].used, 0);
      assert.strictEqual(A.used.length, 0);
      bye(A, B);
    });

    await ok("bots at the table: they use theirs when a human owns some, and none when nobody does", async () => {
      const run = async (power) => {
        const A = client("Ava", { caps: NEW.caps, power }); await connected(A);
        A.s.emit("create", ident(A)); await until(() => A.joinedCode);
        A.s.emit("addBot"); await until(() => A.state && A.state.players.length === 2);
        A.s.emit("settings", { tokens: 2, mode: "power" }); await until(() => A.state.mode === "power" && A.state.tokenChoice === 2);
        A.s.emit("start"); await until(() => A.state.status === "playing");
        const cA = A.state.players[0].color, cBot = A.state.players[1].color;
        const sA = A.state.cfg.starts[cA], sB = A.state.cfg.starts[cBot];
        // the bot's pawn will stand 4 cells ahead of Ava's after its 2: a pawn an enemy can reach
        const botPos = 20, botCell = (sB + botPos + 2) % 52, pA = (botCell - 4 - sA + 104) % 52;
        await stage(A, { turn: 1, tokens: { [cA]: [pA, -1], [cBot]: [botPos, -1] }, dice: [2] });
        await until(() => A.state.turn === 0 && A.state.phase === "roll", 3000);
        return A;
      };
      const A = await run({ shield: 3, step: 3, reroll: 3 });
      assert.strictEqual(A.state.power.seats[1].used, 1, "the bot shielded its pawn");
      assert.strictEqual(A.state.power.seats[1].shield, 0);
      assert.strictEqual(A.used.length, 1);
      assert.strictEqual(A.used[0].seat, 1);
      const N = await run({ shield: 0, step: 0, reroll: 0 });
      assert.strictEqual(N.state.power.seats[1].used, 0, "no human owns any: the bot uses none");
      assert.strictEqual(N.used.length, 0);
      bye(A, N);
    });

    await ok("quick play matches Power only with Power, and a Power game is never rated", async () => {
      const P1 = client("Pia", NEW), C1 = client("Cal", NEW), P2 = client("Pam", NEW), O1 = client("Old", OLD);
      for (const p of [P1, C1, P2, O1]) await connected(p);
      P1.s.emit("quick", Object.assign({ mode: "power" }, ident(P1)));
      assert.ok(await until(() => P1.state && P1.state.quick));
      assert.strictEqual(P1.state.mode, "power");
      C1.s.emit("quick", ident(C1));
      assert.ok(await until(() => C1.state && C1.state.quick));
      assert.strictEqual(C1.state.mode, "classic");
      assert.notStrictEqual(C1.state.code, P1.state.code, "Classic did not join the Power room");
      O1.s.emit("quick", Object.assign({ mode: "power" }, ident(O1)));   // an old app cannot ask for Power: it is matched as Classic
      assert.ok(await until(() => O1.state && O1.state.quick));
      assert.strictEqual(O1.state.code, C1.state.code);
      assert.strictEqual(O1.state.mode, "classic");
      assert.strictEqual(C1.state.rankedOn, true, "Classic quick play is rated as ever");
      P2.s.emit("quick", Object.assign({ mode: "power" }, ident(P2)));
      assert.ok(await until(() => P2.state && P2.state.quick));
      assert.strictEqual(P2.state.code, P1.state.code, "Power joined Power");
      assert.ok(await until(() => P1.state.players.length === 2));
      assert.strictEqual(P1.state.rankedOn, false, "a Power room's result never counts");
      P1.s.emit("settings", { mode: "classic" }); await sleep(120);
      assert.strictEqual(P1.state.mode, "power", "a quick room keeps the mode it was matched on");
      bye(P1, C1, P2, O1);
    });
  } finally {
    srv.kill();
  }
}

(async () => {
  await part1();
  await part2();
  console.log(`\nludo power: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
