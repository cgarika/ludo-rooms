/* Rules-level E2E suite (socket.io clients, no browser).
   Run against a LOCAL server started with fast bots:
     BOT_DELAY_MS=5 PORT=3111 node server.js
   then from repo root:
     node test/e2e.js          (BASE=http://localhost:3111 by default)

   Covers:
   1. Classic 2-player game to completion (regression, incl. chat + bad-code checks)
   2. Bots: addBot / removeBot, bot plays its own turns to game completion
   3. Team mode: 3 humans + team:true auto-adds a bot; full game with
      no same-team captures, play continues after first finisher, winnerTeam sane
   4. Random draws: seat 0 gets different partners across ~12 team games
*/
const { io } = require("socket.io-client");
const BASE = process.env.BASE || "http://localhost:3111";

const results = [];
let cur = null;
const ok = (m) => console.log("  ✓", m);
const bad = (m) => { console.log("  ✗", m); cur.errors.push(m); process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name) {
  const s = io(BASE, { transports: ["websocket"] });
  const p = {
    name, s, seat: -1, state: null, auto: false, emits: 0, lastActedV: 0,
    id: name + "-" + Math.random().toString(36).slice(2, 8),
    watchers: [], lastErr: null,
  };
  s.on("state", ({ room, mySeat }) => {
    p.seat = mySeat;
    p.state = room;
    for (const w of [...p.watchers]) { try { w(room); } catch (e) {} }
    if (p.auto) drive(p);
  });
  s.on("err", (e) => { p.lastErr = e; });
  return p;
}
const connected = (p) => new Promise((r) => (p.s.connected ? r() : p.s.once("connect", r)));

/* mirror of the server's legalMoves, from the public state */
function legal(room, seat) {
  const color = room.players[seat].color;
  const die = room.die, finish = room.cfg.M + 4, out = [];
  if (die == null) return out;
  room.tokens[color].forEach((t, i) => {
    if (t === finish) return;
    if (t === -1) { if (die === 6) out.push(i); }
    else if (t + die <= finish) out.push(i);
  });
  return out;
}

/* auto-player: acts once per state version; prefers finishing, then furthest token */
function drive(p) {
  const r = p.state;
  if (!r || r.status !== "playing" || r.turn !== p.seat) return;
  if (r.v === p.lastActedV) return;
  p.lastActedV = r.v;
  if (r.phase === "roll") { p.s.emit("roll"); p.emits++; }
  else if (r.phase === "move") {
    const lm = legal(r, p.seat);
    if (!lm.length) return;
    const color = r.players[p.seat].color, finish = r.cfg.M + 4;
    let pick = lm.find((i) => r.tokens[color][i] !== -1 && r.tokens[color][i] + r.die === finish);
    if (pick == null) pick = lm.reduce((a, b) => (r.tokens[color][b] > r.tokens[color][a] ? b : a));
    p.s.emit("move", { i: pick }); p.emits++;
  }
}

/* wait until pred(state) on client p; re-nudges a stalled auto-player */
function waitState(p, pred, ms, what) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    if (p.state && pred(p.state)) return resolve(p.state);
    const check = (r) => { if (pred(r)) { cleanup(); resolve(r); } };
    const iv = setInterval(() => {
      if (p.state && pred(p.state)) { cleanup(); return resolve(p.state); }
      if (Date.now() - t0 > ms) { cleanup(); return reject(new Error("timeout waiting for " + what)); }
      if (p.auto && p.state && p.state.status === "playing" && p.state.turn === p.seat) {
        p.lastActedV = 0; drive(p); // resend if an emit was lost/ignored
      }
    }, 300);
    const cleanup = () => { clearInterval(iv); p.watchers = p.watchers.filter((w) => w !== check); };
    p.watchers.push(check);
  });
}

async function makeRoom(host, opts = {}) {
  host.s.emit("create", { name: host.name, playerId: host.id });
  const { code } = await new Promise((r) => host.s.once("joined", r));
  for (const g of opts.guests || []) {
    g.s.emit("join", { code, name: g.name, playerId: g.id });
    await new Promise((r) => g.s.once("joined", r));
  }
  return code;
}

async function test(title, fn) {
  cur = { title, errors: [] };
  console.log("\n▶ " + title);
  const t0 = Date.now();
  try { await fn(); } catch (e) { bad("EXCEPTION: " + e.message); }
  cur.secs = ((Date.now() - t0) / 1000).toFixed(1);
  results.push(cur);
}

(async () => {

  await test("1. Classic 2p game to completion (regression)", async () => {
    const A = client("Alice"), B = client("Bob");
    await Promise.all([connected(A), connected(B)]);
    const code = await makeRoom(A, { guests: [B] });
    ok(`room ${code}: created + joined`);
    await waitState(A, (r) => r.players.length === 2, 5000, "2 players");

    // bad room code is rejected
    const C = client("Eve");
    await connected(C);
    const errP = new Promise((r) => C.s.once("err", r));
    C.s.emit("join", { code: "XXXXXX", name: "Eve", playerId: C.id });
    const errMsg = await Promise.race([errP, sleep(2000).then(() => null)]);
    errMsg ? ok(`bad room code rejected: "${errMsg}"`) : bad("no error for bad room code");
    C.s.close();

    // chat relays
    B.s.emit("chat", { text: "glhf" });
    await waitState(A, (r) => (r.chat || []).some((c) => c.x === "glhf"), 3000, "chat relay")
      .then(() => ok("chat relayed to the other player"), () => bad("chat not relayed"));

    A.auto = B.auto = true;
    A.s.emit("start", {});
    const over = await waitState(A, (r) => r.status === "over", 120000, "2p game over");
    const finish = over.cfg.M + 4;
    if (over.winner && over.tokens[over.winner].every((t) => t === finish))
      ok(`game completed: ${over.winner} won with all ${over.cfg.tpp} tokens home (v${over.v})`);
    else bad("game over but winner tokens not all home: " + JSON.stringify(over.tokens[over.winner]));
    await waitState(B, (r) => r.status === "over", 5000, "Bob sees game over");
    if (A.state.v === B.state.v) ok(`clients in sync at v${A.state.v}`);
    else bad(`desync: v${A.state.v} vs v${B.state.v}`);
    A.s.emit("leave"); B.s.emit("leave"); await sleep(200);
    A.s.close(); B.s.close();
  });

  await test("2. Bot: add/remove, bot plays itself to completion vs one human", async () => {
    const H = client("Host");
    await connected(H);
    await makeRoom(H);
    H.s.emit("addBot");
    let st = await waitState(H, (r) => r.players.length === 2, 3000, "bot added");
    const b = st.players[1];
    if (b.bot && b.name && b.avatar === "\u{1F916}") ok(`addBot: "${b.name}" joined as 🤖 bot (color ${b.color})`);
    else bad("bot player malformed: " + JSON.stringify(b));

    H.s.emit("removeBot");
    await waitState(H, (r) => r.players.length === 1, 3000, "bot removed");
    ok("removeBot: bot left the lobby");

    H.s.emit("addBot");
    await waitState(H, (r) => r.players.length === 2, 3000, "bot re-added");

    let botRolled = false, botMoved = false;
    H.watchers.push((r) => {
      if (r.status !== "playing") return;
      const bs = r.players.findIndex((p) => p.bot);
      if (r.turn === bs && r.phase === "move") botRolled = true; // only the server bot can roll on its turn
      const bc = r.players[bs] && r.players[bs].color;
      if (bc && r.tokens[bc] && r.tokens[bc].some((t) => t !== -1)) botMoved = true;
    });
    H.auto = true;
    H.s.emit("start", {});
    const over = await waitState(H, (r) => r.status === "over", 120000, "bot game over");
    ok(`game completed, winner: ${over.winner} (human emitted ${H.emits} actions)`);
    botRolled ? ok("bot rolled its own dice (state advanced on bot's turn with 1 human client)") : bad("bot never rolled");
    botMoved ? ok("bot moved its own tokens out of base") : bad("bot tokens never left base");
    H.s.emit("leave"); await sleep(200); H.s.close();
  });

  await test("3. Team mode: 3 humans + auto-bot, full game, team rules hold", async () => {
    const H = client("Tessa"), P2 = client("Uma"), P3 = client("Vik");
    await Promise.all([connected(H), connected(P2), connected(P3)]);
    await makeRoom(H, { guests: [P2, P3] });
    H.s.emit("settings", { team: true });
    await waitState(H, (r) => r.teamChoice === true, 3000, "teamChoice on");
    ok("host toggled team mode on");

    const sameTeamCaptures = [];
    let totalCaptures = 0;
    const capSeen = new Set();
    let firstFinishV = null, continuedAfterFinish = false;
    H.watchers.push((r) => {
      if (!r.teamOf) return;
      const finish = r.cfg ? r.cfg.M + 4 : null;
      if (r.lastMove && r.lastMove.captured && r.lastMove.captured.length && !capSeen.has(r.lastMove.mv)) {
        capSeen.add(r.lastMove.mv);
        const mSeat = r.players.findIndex((p) => p.color === r.lastMove.color);
        for (const cap of r.lastMove.captured) {
          totalCaptures++;
          const vSeat = r.players.findIndex((p) => p.color === cap.c);
          if (r.teamOf[mSeat] === r.teamOf[vSeat])
            sameTeamCaptures.push(`${r.lastMove.color} captured teammate ${cap.c} at mv ${r.lastMove.mv}`);
        }
      }
      if (r.status === "playing" && finish) {
        const done = r.players.filter((p) => r.tokens[p.color].every((t) => t === finish));
        if (done.length && firstFinishV == null) firstFinishV = r.v;
        if (firstFinishV != null && r.v > firstFinishV) continuedAfterFinish = true;
      }
    });

    H.auto = P2.auto = P3.auto = true;
    H.s.emit("start", {});
    const st = await waitState(H, (r) => r.status === "playing", 5000, "team game start");
    if (st.players.length === 4 && st.players.some((p) => p.bot)) ok("start auto-added a bot to fill the 4th seat");
    else bad("expected 4 players incl. a bot, got " + JSON.stringify(st.players.map((p) => p.name)));
    if (st.teamMode === true && Array.isArray(st.teamOf) && st.teamOf.length === 4
        && st.teamOf.filter((t) => t === 0).length === 2)
      ok(`teamMode on, teams drawn 2v2: teamOf=${JSON.stringify(st.teamOf)}`);
    else bad("teamMode/teamOf malformed: " + JSON.stringify({ teamMode: st.teamMode, teamOf: st.teamOf }));

    const over = await waitState(H, (r) => r.status === "over", 300000, "team game over");
    ok(`team game completed in ${over.v} state versions (${totalCaptures} captures seen)`);
    sameTeamCaptures.length === 0
      ? ok("zero captures between same-team seats")
      : bad("SAME-TEAM CAPTURES: " + sameTeamCaptures.join("; "));
    continuedAfterFinish
      ? ok("game continued after the first player got everything home")
      : bad("game did not continue after first finisher (or none observed)");
    const finish = over.cfg.M + 4;
    const wt = over.winnerTeam;
    if (Array.isArray(wt) && wt.length === 2) {
      const s0 = over.players.findIndex((p) => p.color === wt[0]);
      const s1 = over.players.findIndex((p) => p.color === wt[1]);
      over.teamOf[s0] === over.teamOf[s1]
        ? ok(`winnerTeam ${JSON.stringify(wt)} are partners (team ${over.teamOf[s0]})`)
        : bad("winnerTeam are NOT partners: " + JSON.stringify(wt));
      wt.every((c) => over.tokens[c].every((t) => t === finish))
        ? ok("both winners have every token home")
        : bad("a winnerTeam color has tokens not home: " + JSON.stringify(wt.map((c) => over.tokens[c])));
    } else bad("winnerTeam missing/malformed: " + JSON.stringify(wt));
    [H, P2, P3].forEach((p) => { p.s.emit("leave"); });
    await sleep(200);
    [H, P2, P3].forEach((p) => p.s.close());
  });

  await test("4. Random draws: seat 0 gets different partners across 12 team games", async () => {
    const partners = new Map();
    for (let g = 0; g < 12; g++) {
      const H = client("Draw" + g);
      await connected(H);
      await makeRoom(H);
      H.s.emit("settings", { team: true });
      H.s.emit("addBot"); H.s.emit("addBot"); H.s.emit("addBot");
      await waitState(H, (r) => r.players.length === 4 && r.teamChoice, 3000, "4 seats + teams");
      H.s.emit("start", {});
      const st = await waitState(H, (r) => r.teamMode && r.teamOf, 3000, "teams drawn");
      const mate = st.teamOf.findIndex((t, s) => s > 0 && t === st.teamOf[0]);
      partners.set(mate, (partners.get(mate) || 0) + 1);
      H.s.emit("leave"); await sleep(50); H.s.close();
    }
    const dist = [...partners.entries()].map(([s, n]) => `seat ${s}×${n}`).join(", ");
    partners.size >= 2
      ? ok(`seat 0 drew ${partners.size} different partners over 12 games (${dist})`)
      : bad(`seat 0 always drew the same partner over 12 games (${dist}) — draw not random?`);
  });

  console.log("\n════════ RULES SUITE SUMMARY ════════");
  for (const r of results)
    console.log(` ${r.errors.length ? "FAIL" : "PASS"}  ${r.title}  (${r.secs}s)${r.errors.length ? "\n        " + r.errors.join("\n        ") : ""}`);
  const failed = results.filter((r) => r.errors.length).length;
  console.log(failed ? `\n=== RESULT: FAIL (${failed} of ${results.length}) ===` : "\n=== RESULT: PASS ===");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
