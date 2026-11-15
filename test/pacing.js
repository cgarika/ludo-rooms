/* Bot pacing (pacing round 1, 2026-11-01): what a bot's wait is for each kind of action, and the watchdog that makes a bot act
   when its timer was lost. In-process, no sockets, so nothing here touches a port. Run: node test/pacing.js */
const assert = require("assert");
process.env.BOT_STALL_MS = "300";
delete process.env.BOT_DELAY_MS;
const S = require("../server.js");
let passed = 0, failed = 0;
const ok = async (name, fn) => { try { await fn(); passed++; console.log("  ok " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n      " + (e && e.message)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function table(red, green, die, phase = "move") {
  const room = { code: "TESTPC", cfg: S.buildConfig(["red", "green"], 4), players: [{ color: "red", bot: true, name: "Robo" }, { color: "green", name: "Ava" }], turn: 0, die, phase, sixes: 0,
    teamMode: false, teamOf: null, tokens: { red, green }, status: "playing", v: 1, log: "", lastMove: null };
  return room;
}
const range = (room, n = 80) => { const xs = []; for (let i = 0; i < n; i++) xs.push(S.botDelay(room)); return [Math.min(...xs), Math.max(...xs)]; };

(async () => {
  console.log("ludo pacing: how long a bot takes");
  await ok("a roll takes 0.5-0.9 s", () => { const [lo, hi] = range(table([10, -1, -1, -1], [-1, -1, -1, -1], null, "roll")); assert.ok(lo >= 500 && hi <= 900, `${lo}..${hi}`); });
  await ok("a forced move takes 0.1-0.25 s", () => { const [lo, hi] = range(table([10, -1, -1, -1], [-1, -1, -1, -1], 3)); assert.ok(lo >= 100 && hi <= 250, `${lo}..${hi}`); });
  await ok("a capture takes 0.45-0.8 s", () => { const [lo, hi] = range(table([20, 30, -1, -1], [12, 22, -1, -1], 5)); assert.ok(lo >= 450 && hi <= 800, `${lo}..${hi}`); });
  await ok("an exact finish takes 0.4-0.7 s", () => { const [lo, hi] = range(table([53, 10, -1, -1], [-1, -1, -1, -1], 3)); assert.ok(lo >= 400 && hi <= 700, `${lo}..${hi}`); });
  await ok("a piece out on a six takes 0.35-0.65 s", () => { const [lo, hi] = range(table([-1, 20, -1, -1], [-1, -1, -1, -1], 6)); assert.ok(lo >= 350 && hi <= 650, `${lo}..${hi}`); });
  await ok("a rescue takes 0.6-1.0 s", () => { const [lo, hi] = range(table([5, 30, -1, -1], [41, -1, -1, -1], 3)); assert.ok(lo >= 600 && hi <= 1000, `${lo}..${hi}`); });
  await ok("a calm choice among several takes 0.6-1.2 s", () => { const [lo, hi] = range(table([16, 40, -1, -1], [-1, -1, -1, -1], 5)); assert.ok(lo >= 600 && hi <= 1200, `${lo}..${hi}`); });
  await ok("no wait is ever over 2.2 s, and the waits of one kind are not all alike", () => {
    let all = [];
    for (const room of [table([20, 30, -1, -1], [12, 22, -1, -1], 5), table([16, 40, -1, -1], [-1, -1, -1, -1], 5), table([5, 30, -1, -1], [41, -1, -1, -1], 3)]) for (let i = 0; i < 50; i++) all.push(S.botDelay(room));
    assert.ok(Math.max(...all) <= 2200);
    assert.ok(new Set(all.map((x) => Math.floor(x / 50))).size >= 8, "only " + new Set(all.map((x) => Math.floor(x / 50))).size + " bands of 50 ms");
  });
  await ok("the choice's reasons are the old picks' (botPick is botDecide's index)", () => {
    for (const [red, green, die] of [[[20, 30, -1, -1], [12, 22, -1, -1], 5], [[53, 10, -1, -1], [-1, -1, -1, -1], 3], [[5, 30, -1, -1], [41, -1, -1, -1], 3], [[-1, 20, -1, -1], [-1, -1, -1, -1], 6], [[16, 40, -1, -1], [-1, -1, -1, -1], 5]]) {
      const room = table(red, green, die), lm = S.legalMoves(room);
      assert.strictEqual(S.botPick(room, lm), S.botDecide(room, lm).i);
    }
    const w = (red, green, die) => { const room = table(red, green, die); return S.botDecide(room, S.legalMoves(room)).why; };
    assert.strictEqual(w([20, 30, -1, -1], [12, 22, -1, -1], 5), "capture");
    assert.strictEqual(w([53, 10, -1, -1], [-1, -1, -1, -1], 3), "finish");
    assert.strictEqual(w([5, 30, -1, -1], [41, -1, -1, -1], 3), "rescue");
    assert.strictEqual(w([-1, 20, -1, -1], [-1, -1, -1, -1], 6), "out");
    assert.strictEqual(w([16, 40, -1, -1], [-1, -1, -1, -1], 5), "safe");
  });

  console.log("ludo pacing: the watchdog");
  await ok("a bot whose timer was lost acts BOT_STALL_MS after its time, by the watchdog", async () => {
    const room = table([-1, -1, -1, -1], [-1, -1, -1, -1], null, "roll");
    room.code = "WATCH1";
    S.rooms.set(room.code, room);
    const before = S.botStats.watchdog;
    S.scheduleBot(room.code);
    assert.ok(S.botTimers.has(room.code) && S.botWatches.has(room.code));
    clearTimeout(S.botTimers.get(room.code)); S.botTimers.delete(room.code);   // the lost timer
    const v0 = room.v;
    await sleep(1500);
    assert.ok(room.v > v0, "the table did not move");
    assert.strictEqual(S.botStats.watchdog, before + 1);
    S.rooms.delete(room.code);
  });
  await ok("a bot that acts in time leaves the watchdog nothing to do", async () => {
    const room = table([-1, -1, -1, -1], [-1, -1, -1, -1], null, "roll");
    room.code = "WATCH2";
    S.rooms.set(room.code, room);
    const before = S.botStats.watchdog;
    S.scheduleBot(room.code);
    await sleep(1400);
    assert.ok(room.v > 1, "the bot did not roll");
    assert.strictEqual(S.botStats.watchdog, before);
    S.rooms.delete(room.code);
  });
  await ok("an action that throws is played the old way (the whole turn), not left", async () => {
    const room = table([-1, -1, -1, -1], [-1, -1, -1, -1], null, "roll");
    room.code = "WATCH3";
    S.rooms.set(room.code, room);
    const real = console.error; console.error = () => {};
    const failedBefore = S.botStats.failed;
    try {
      room.cfg = null;   // legalMoves and the rest throw on this
      S.botAction(room);
      assert.strictEqual(S.botStats.failed, failedBefore + 1);
    } finally { console.error = real; S.rooms.delete(room.code); }
  });
  console.log(`${passed} passed${failed ? ", " + failed + " FAILED" : ""}`);
  process.exit(failed ? 1 : 0);
})();
