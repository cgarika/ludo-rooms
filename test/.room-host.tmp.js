/* Host a live ludo room for N players: create, add N-2 bots, wait for one more joiner (the app), start, stay alive.
   node .room-host.tmp.js <N> [server] [path]   → prints CODE=XXXXXX */
const { io } = require("socket.io-client");
const N = Number(process.argv[2] || 6), SERVER = process.argv[3] || "https://gamenestapp.com", PATH = process.argv[4] || "/ludo/socket.io";
const s = io(SERVER, { path: PATH, transports: ["websocket"] });
let code = null, started = false, bots = 0;
s.on("connect", () => s.emit("create", { name: "Host", playerId: "host-" + Date.now().toString(36), avatar: "\u{1F451}" }));
s.on("joined", (d) => { code = d.code; console.log("CODE=" + code); });
s.on("err", (e) => console.log("err:", e));
s.on("state", ({ room }) => {
  if (!room) return;
  if (room.status === "lobby") {
    if (bots < N - 2) { bots++; setTimeout(() => s.emit("addBot"), 250); return; }
    if (room.players.length >= N && !started) { started = true; console.log("players:", room.players.map((p) => p.name + (p.bot ? "(bot)" : "")).join(", ")); setTimeout(() => s.emit("start", {}), 800); }
  } else if (room.status === "playing" && !global.announced) { global.announced = true; console.log("STARTED mode=" + room.cfg.mode + " M=" + room.cfg.M + " players=" + room.players.length); }
});
setTimeout(() => { s.disconnect(); process.exit(0); }, Number(process.env.KEEP_MS || 240000));
