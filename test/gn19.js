/* GN-19: the four-seat cross board always holds the classic four colours.
   Starts its own server on TEST_PORT (default 3141; never 3111-3118) and plays over real sockets:
   - a lobby of five where the third player (green) leaves, started at four: the orange seat plays green; every
     seat has a start on the cross board and four pieces; the log says who changed colour; rolls play on;
   - a five-seat game (circle board) where yellow leaves mid-game, then a rematch at four: the same;
   - a plain lobby of four keeps its colours and its log untouched. */
"use strict";
const { io } = require("socket.io-client");
const { spawn } = require("child_process");
const path = require("path");

const PORT = Number(process.env.TEST_PORT || 3141);
if (PORT >= 3111 && PORT <= 3118) { console.error("refusing " + PORT); process.exit(2); }
const URL = "http://localhost:" + PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(10); } return false; };
function assert(c, m) { if (!c) throw new Error(m); }
let n = 0;
const socks = [];
function mk() {
  const c = io(URL, { transports: ["websocket"], reconnection: false, forceNew: true });
  c.st = null; c.pid = "g19_" + (++n) + "_" + Math.random().toString(36).slice(2, 8); c.errs = [];
  c.logs = [];
  c.on("state", (s) => { c.st = s.room || s; if (c.st.log && c.logs[c.logs.length - 1] !== c.st.log) c.logs.push(c.st.log); });
  c.on("err", (m) => c.errs.push(m));
  c.on("joined", (j) => { c.code = j.code; });
  socks.push(c);
  return c;
}
async function lobby(count) {
  const cs = Array.from({ length: count }, mk);
  await until(() => cs.every((c) => c.connected));
  cs[0].emit("create", { name: "N0", playerId: cs[0].pid });
  await until(() => cs[0].code);
  for (let i = 1; i < count; i++) { cs[i].emit("join", { code: cs[0].code, name: "N" + i, playerId: cs[i].pid }); await until(() => cs[0].st && cs[0].st.players.length === i + 1); }
  return cs;
}
function crossOk(st) {
  const colours = st.players.filter((p) => !p.left).map((p) => p.color);
  return st.cfg.mode === "cross" && colours.every((c) => ["red", "green", "yellow", "blue"].includes(c))
    && colours.every((c) => Number.isInteger(st.cfg.starts[c]) && Array.isArray(st.tokens[c]) && st.tokens[c].length === st.cfg.tpp)
    && new Set(colours).size === colours.length;
}

(async () => {
  const srv = spawn(process.execPath, ["server.js"], { cwd: path.join(__dirname, ".."), env: { ...process.env, PORT: String(PORT), BOT_DELAY_MS: "5", TURN_MS: "500", AFK_MS: "200" }, stdio: "ignore" });
  try {
    await sleep(700);
    // 1. a lobby of five, green leaves, start at four
    {
      const cs = await lobby(5);
      assert(cs[0].st.players.map((p) => p.color).join() === "red,yellow,green,blue,orange", "join order colours: " + cs[0].st.players.map((p) => p.color));
      cs[2].emit("leave");
      await until(() => cs[0].st.players.length === 4);
      cs[0].emit("start");
      await until(() => cs[0].st.status === "playing");
      const st = cs[0].st;
      assert(crossOk(st), "cross board with the classic four: " + JSON.stringify({ players: st.players.map((p) => [p.name, p.color]), starts: st.cfg.starts }));
      assert(st.players.find((p) => p.name === "N4").color === "green", "the orange seat plays green");
      assert(/N4 plays green on the four-colour board/.test(st.log), "the log says so: " + st.log);
      const who = cs[Number(st.players[st.turn].name.slice(1))], v0 = st.v;
      who.emit("roll");
      await until(() => cs[0].st.v > v0 && /rolled/.test(cs[0].st.log));
      assert(/rolled/.test(cs[0].st.log) && cs.every((c) => c.errs.length === 0), "a roll plays on the recoloured board: " + cs[0].st.log);
      console.log("PASS GN-19 lobby — five, green left, started at four: orange plays green, every seat has a start and pieces");
    }
    // 2. five seats (circle), yellow leaves mid-game, the absent humans time out to bots, rematch at four
    {
      const cs = [mk(), mk(), mk()];
      await until(() => cs.every((c) => c.connected));
      cs[0].emit("create", { name: "N0", playerId: cs[0].pid }); await until(() => cs[0].code);
      cs[1].emit("join", { code: cs[0].code, name: "N1", playerId: cs[1].pid }); await until(() => cs[0].st.players.length === 2);
      cs[0].emit("addBot"); cs[0].emit("addBot"); await until(() => cs[0].st.players.length === 4);
      cs[2].emit("join", { code: cs[0].code, name: "N2", playerId: cs[2].pid }); await until(() => cs[0].st.players.length === 5);
      assert(cs[0].st.players.map((p) => p.color).join() === "red,yellow,green,blue,orange", "colours: " + cs[0].st.players.map((p) => p.color));
      cs[0].emit("start");
      await until(() => cs[0].st.status === "playing");
      assert(cs[0].st.cfg.mode === "circle", "five seats play the circle board");
      cs[1].emit("leave");
      await until(() => cs[0].st.players.some((p) => p.left));
      await until(() => cs[0].st.status === "over", 120000);   // nobody acts: the humans time out to bots, and the bots finish it
      assert(cs[0].st.status === "over", "the game ended");
      cs[0].emit("rematch");
      await until(() => cs[0].st.status === "playing");
      const st = cs[0].st;
      assert(crossOk(st), "rematch at four on the cross board with the classic four: " + st.players.map((p) => p.name + " " + p.color));
      assert(st.players.find((p) => p.name === "N2").color === "yellow", "orange took yellow");
      assert(cs[0].logs.some((l) => /^Rematch! .* N2 plays yellow on the four-colour board\.$/.test(l)), "the rematch's log says so: " + cs[0].logs.slice(-4).join(" | "));
      console.log("PASS GN-19 rematch — a five-seat circle game lost yellow; the rematch at four seats orange as yellow on the cross board");
    }
    // 3. a plain four keeps everything
    {
      const cs = await lobby(4);
      cs[0].emit("start");
      await until(() => cs[0].st.status === "playing");
      assert(cs[0].st.players.map((p) => p.color).join() === "red,green,yellow,blue", "colours kept (sorted as before)");
      assert(!/four-colour board/.test(cs[0].st.log), "no note when nothing changed");
      console.log("PASS GN-19 unchanged — a plain lobby of four keeps its colours and its log");
    }
    console.log("ALL GN-19 TESTS PASS");
    process.exitCode = 0;
  } catch (e) { console.error("FAIL:", e.message); process.exitCode = 1; }
  finally { socks.forEach((c) => c.close()); srv.kill(); setTimeout(() => process.exit(process.exitCode), 100); }
})();
