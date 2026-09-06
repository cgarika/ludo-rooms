/* Load / stress harness against the live arcade (gamenestapp.com socket proxies, same containers as needasix.com).
   Each "room" = one socket that creates a room, adds bots, starts; the SERVER then plays the bots against an idle host
   (its turn times out). A subset of rooms are "probes": the host rolls on its own turn and measures roll→state latency.
   node load.js <rooms per game> <games csv> <hold seconds> [ramp rooms/step] [step seconds] [max rooms per game]
   Prints one line per 15 s: rooms, sockets, states/s, errors, p50/p95 roll latency; exits 0. */
const { io } = require("socket.io-client");
const [RPG, GAMES, HOLD, RAMP, STEP, MAXR] = [Number(process.argv[2] || 10), (process.argv[3] || "ludo,snakes,eights").split(","), Number(process.argv[4] || 120), Number(process.argv[5] || 0), Number(process.argv[6] || 60), Number(process.argv[7] || 0)];
const BOTS = { ludo: 3, snakes: 3, eights: 3, mafia: 5, rummy: 3 };
const st = { rooms: 0, sockets: 0, states: 0, errors: 0, lat: [], failedCreate: 0, disconnects: 0 };
const all = [];
function room(game, probe) {
  const s = io("https://gamenestapp.com", { path: `/${game}/socket.io`, transports: ["websocket"], reconnection: false, timeout: 15000 });
  const R = { s, game, code: null, started: false, bots: 0, rollAt: 0, alive: true };
  all.push(R); st.sockets++;
  const t = setTimeout(() => { if (!R.code) { st.failedCreate++; } }, 20000);
  s.on("connect", () => s.emit("create", { name: "Load" + Math.floor(Math.random() * 1e4), playerId: "ld-" + Math.random().toString(36).slice(2), avatar: "\u{1F916}" }));
  s.on("joined", (d) => { R.code = d.code; clearTimeout(t); st.rooms++; });
  s.on("err", () => st.errors++);
  s.on("connect_error", () => { st.errors++; st.failedCreate++; });
  s.on("disconnect", () => { if (R.alive) st.disconnects++; });
  s.on("state", ({ room }) => {
    st.states++; if (!room) return;
    if (R.rollAt) { st.lat.push(Date.now() - R.rollAt); R.rollAt = 0; }   // server response: first state after our roll
    if (room.status === "lobby") {
      if (R.bots < (BOTS[game] || 3)) { R.bots++; setTimeout(() => s.emit("addBot"), 150 + Math.random() * 300); return; }
      if (!R.started) { R.started = true; setTimeout(() => s.emit("start", {}), 300); }
    } else if (room.status === "playing" && probe) {
      const me = room.players.findIndex((p) => p.name && p.name.startsWith("Load"));
      if (room.turn === me) {
        if (!R.pending && (room.phase === "roll" || room.phase === "turn" || room.phase === undefined)) {
          R.pending = true; setTimeout(() => { R.rollAt = Date.now(); s.emit(game === "eights" ? "draw" : "roll"); R.pending = false; }, 400);
        }
      }
    } else if (room.status === "over" && !R.over) { R.over = true; setTimeout(() => s.emit("rematch"), 1500); R.started = false; R.bots = BOTS[game] || 3; }
  });
}
function addBatch(n) { for (const g of GAMES) for (let i = 0; i < n; i++) room(g, true); }
const pct = (a, p) => { if (!a.length) return "-"; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]; };
let lastStates = 0, t0 = Date.now(), perGame = RPG;
addBatch(RPG);
const tick = setInterval(() => {
  const now = Date.now(), sps = ((st.states - lastStates) / 15).toFixed(1); lastStates = st.states;
  const lat = st.lat.splice(0);
  console.log(`t=${Math.round((now - t0) / 1000)}s rooms=${st.rooms}/${all.length} states/s=${sps} errors=${st.errors} createFail=${st.failedCreate} drops=${st.disconnects} roll p50=${pct(lat, .5)} p95=${pct(lat, .95)} n=${lat.length}`);
}, 15000);
if (RAMP) { const ramp = setInterval(() => { if (MAXR && perGame >= MAXR) { clearInterval(ramp); return; } perGame += RAMP; addBatch(RAMP); console.log(`+${RAMP} rooms/game → ${perGame}/game`); }, STEP * 1000); }
setTimeout(() => { clearInterval(tick); for (const R of all) { R.alive = false; try { R.s.emit("leave"); R.s.disconnect(); } catch {} } console.log(`DONE rooms=${st.rooms} states=${st.states} errors=${st.errors} createFail=${st.failedCreate} drops=${st.disconnects}`); setTimeout(() => process.exit(0), 1500); }, HOLD * 1000);
