/* Generic live-room host for the arcade games: node .host-any.tmp.js <path e.g. /snakes|/eights|/ludo> <players incl. app> [autoRoll]
   create → add (players-2) bots → wait for the app to join → start. Prints CODE=…  With autoRoll, rolls on its own turn (snakes). */
const { io } = require("socket.io-client");
const [PATH, NSTR, AUTO] = process.argv.slice(2); const N = Number(NSTR || 3);
const s = io("https://gamenestapp.com", { path: PATH + "/socket.io", transports: ["websocket"] });
let bots = 0, started = false, created = false;
s.on("connect", () => { if (created) return; created = true; s.emit("create", { name: "Host", playerId: "host-" + Date.now().toString(36), avatar: "\u{1F451}" }); });
s.on("joined", (d) => console.log("CODE=" + d.code));
s.on("err", (e) => console.log("err:", e));
s.on("state", ({ room }) => {
  if (!room) return;
  if (room.status === "lobby") {
    if (bots < N - 2) { bots++; setTimeout(() => s.emit("addBot"), 250); return; }
    if (room.players.length >= N && !started) { started = true; console.log("players:", room.players.map((p) => p.name).join(", ")); setTimeout(() => s.emit("start", {}), 800); }
  } else if (room.status === "playing") {
    if (!global.a) { global.a = true; console.log("STARTED"); }
    if (AUTO) { const me = room.players.findIndex((p) => p.name === "Host"); if (room.turn === me && !global.r) { global.r = true; setTimeout(() => { if (AUTO === "draw") { if (room.phase === "drawn") s.emit("keep"); else s.emit("draw"); } else s.emit("roll"); global.r = false; }, 900); } }
  }
});
setTimeout(() => { s.disconnect(); process.exit(0); }, Number(process.env.KEEP_MS || 240000));
