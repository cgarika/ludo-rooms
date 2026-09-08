/* T1 AFK policy suite (socket.io clients, no browser). Starts its own server with fast clocks on PORT 3121:
     TURN_MS=700 AFK_MS=250 BOT_DELAY_MS=5
   then proves:
   1. a disconnected player's turn is auto-played after AFK_MS (not the normal TURN_MS) and the turn advances
   2. three consecutive timeouts flip the seat to botControlled (state field visible to clients)
   3. one human action (roll) clears the flag and the streak; "takeSeat" also clears it
   4. a bot-controlled seat completes a whole game without stalling
   Run from repo root: node test/afk.js */
const { spawn } = require("child_process");
const { io } = require("socket.io-client");
const PORT = 3121, BASE = `http://localhost:${PORT}`;
const TURN_MS = 700, AFK_MS = 250;
let failed = 0; const ok = (m) => console.log("  ✓", m); const bad = (m) => { console.log("  ✗", m); failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name) {
  const s = io(BASE, { transports: ["websocket"], reconnection: false });
  const p = { name, s, seat: -1, state: null, logs: [], id: name + "-" + Math.random().toString(36).slice(2, 8), joinedCode: null };
  s.on("state", ({ room, mySeat }) => { p.seat = mySeat; p.state = room; if (room && room.log) p.logs.push(room.log); });
  s.on("joined", (j) => { p.joinedCode = j.code; });
  return p;
}
const until = async (fn, ms = 4000, step = 20) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; };
const connected = (p) => new Promise((r) => (p.s.connected ? r() : p.s.once("connect", r)));

async function room2(tokens = 2) {
  const A = client("A"), B = client("B"); await connected(A); await connected(B);
  A.s.emit("create", { name: "A", playerId: A.id, avatar: "\u{1F98A}" }); await until(() => A.joinedCode);
  B.s.emit("join", { code: A.joinedCode, name: "B", playerId: B.id, avatar: "\u{1F43C}" }); await until(() => B.state && B.state.players.length === 2);
  A.s.emit("settings", { tokens }); await until(() => A.state && A.state.tokenChoice === tokens);
  A.s.emit("start"); await until(() => A.state && A.state.status === "playing");
  return { A, B, code: A.joinedCode };
}

(async () => {
  const srv = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT: String(PORT), TURN_MS: String(TURN_MS), AFK_MS: String(AFK_MS), BOT_DELAY_MS: "5" }, stdio: "ignore" });
  await sleep(600);
  try {
    // ---- 1. disconnected player: AFK clock, turn auto-played
    {
      const { A, B } = await room2();
      // seat 0 (A) rolls first. Disconnect A during its own turn.
      A.s.disconnect();
      const t0 = Date.now();
      const advanced = await until(() => B.state && B.state.turn !== 0, TURN_MS + 800);
      const dt = Date.now() - t0;
      advanced ? ok(`disconnected player's turn was auto-played after ${dt} ms (AFK ${AFK_MS} ms, normal ${TURN_MS} ms)`) : bad("disconnected player's turn was not auto-played");
      dt < TURN_MS ? ok("it fired on the AFK clock, not the normal one") : bad(`took ${dt} ms, i.e. the normal clock`);
      (await until(() => B.logs.some((l) => /played for them/.test(l)), 600)) ? ok("timeout note visible in the log") : bad("no timeout note in the log");
      B.s.disconnect();
    }
    // ---- 2 + 3. three timeouts → botControlled; human action clears it; takeSeat clears it
    {
      const { A, B } = await room2();
      // B stays connected but never acts on its turns; A plays normally (auto-driver)
      const drive = (p) => { const r = p.state; if (!r || r.status !== "playing" || r.turn !== p.seat) return; if (r.phase === "roll") p.s.emit("roll"); else if (r.phase === "move") { const c = r.players[p.seat].color, f = r.cfg.M + 4; const i = r.tokens[c].findIndex((t, k) => t !== f && (t === -1 ? r.die === 6 : t + r.die <= f)); if (i >= 0) p.s.emit("move", { i }); } };
      A.s.on("state", () => setTimeout(() => drive(A), 10));
      const flipped = await until(() => B.state && B.state.players[1].botControlled, TURN_MS * 8);
      flipped ? ok("three consecutive timeouts marked the idle seat as botControlled") : bad("seat never became botControlled");
      if (flipped) {
        const n = B.state.players[1]; n.name === "B" && !n.bot ? ok("the seat kept the human's name and is not a plain bot") : bad("seat identity changed");
        const logged = await until(() => B.logs.some((l) => /playing for B/.test(l)), 500); logged ? ok("takeover log line shown") : bad("no takeover log line");
        // takeSeat hands control back
        B.s.emit("takeSeat"); const back = await until(() => !B.state.players[1].botControlled, 1500);
        back ? ok("takeSeat returned control to the human") : bad("takeSeat did not clear botControlled");
        (await until(() => B.logs.some((l) => /back at the table/.test(l)), 500)) ? ok("return log line shown") : bad("no return log line");
        // let it flip again, then a real action (roll) should clear it
        const again = await until(() => B.state.players[1].botControlled, TURN_MS * 8);
        again ? ok("idle again → bot took the seat again") : bad("seat did not flip a second time");
        if (again) { await until(() => B.state.turn === 1 && B.state.phase === "roll", TURN_MS * 4); B.s.emit("roll"); const cleared = await until(() => !B.state.players[1].botControlled, 1500); cleared ? ok("a human roll took the seat back and reset the streak") : bad("human action did not clear botControlled"); }
      }
      A.s.disconnect(); B.s.disconnect();
    }
    // ---- 4. bot-controlled seat finishes a whole game
    {
      const { A, B } = await room2(2);
      A.s.on("state", () => { const r = A.state; if (r && r.status === "playing" && r.turn === 0) { if (r.phase === "roll") A.s.emit("roll"); else if (r.phase === "move") { const c = r.players[0].color, f = r.cfg.M + 4; const i = r.tokens[c].findIndex((t, k) => t !== f && (t === -1 ? r.die === 6 : t + r.die <= f)); if (i >= 0) A.s.emit("move", { i }); } } });
      B.s.disconnect();   // B never acts → AFK clock → 3 timeouts → bot plays every turn instantly
      const over = await until(() => A.state && A.state.status === "over", 60000, 50);
      over ? ok(`game with a bot-controlled seat finished (winner ${A.state.winner}, ${A.state.v} state versions)`) : bad("game with a bot-controlled seat stalled");
      A.state && A.state.players[1].botControlled ? ok("the absent seat was bot-controlled by the end") : bad("absent seat never became bot-controlled");
      A.s.disconnect();
    }
  } catch (e) { bad("suite error: " + e.message); }
  srv.kill();
  console.log(failed ? `\n=== AFK: FAIL (${failed}) ===` : "\n=== AFK: PASS ===");
  process.exit(failed ? 1 : 0);
})();
