/* Host a live Snakebite room: create, add one bot, wait for the app to join, start; the host never rolls (its turn times out), bot + app play. */
const { io } = require("socket.io-client");
const s = io("https://gamenestapp.com", { path: "/snakes/socket.io", transports: ["websocket"] });
let bots = 0, started = false;
s.on("connect", () => s.emit("create", { name: "Host", playerId: "host-" + Date.now().toString(36), avatar: "\u{1F451}" }));
s.on("joined", (d) => console.log("CODE=" + d.code));
s.on("err", (e) => console.log("err:", e));
s.on("state", ({ room }) => {
  if (!room) return;
  if (room.status === "lobby") {
    if (bots < 1) { bots++; setTimeout(() => s.emit("addBot"), 250); return; }
    if (room.players.length >= 3 && !started) { started = true; console.log("players:", room.players.map((p) => p.name).join(", ")); setTimeout(() => s.emit("start"), 800); }
  } else if (room.status === "playing") {
    if (!global.a) { global.a = true; console.log("STARTED"); }
    // host rolls on its own turn so the table keeps moving (bot rolls itself; the app's turn times out)
    const me = room.players.findIndex((p) => p.name === "Host");
    if (room.turn === me && !global.rolling) { global.rolling = true; setTimeout(() => { s.emit("roll"); global.rolling = false; }, 900); }
  }
});
setTimeout(() => { s.disconnect(); process.exit(0); }, Number(process.env.KEEP_MS || 240000));
