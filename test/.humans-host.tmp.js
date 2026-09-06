/* Live room with HUMAN sockets (for games that refuse bots): node .humans-host.tmp.js <path> <humans incl. app>
   create → (humans-2) extra human sockets join → wait for the app → start. Prints CODE=… */
const { io } = require("socket.io-client");
const [PATH, NSTR] = process.argv.slice(2); const N = Number(NSTR || 3);
const mk = (name) => io("https://gamenestapp.com", { path: PATH + "/socket.io", transports: ["websocket"] });
const host = mk("Host"); let code = null, started = false, joined = 0;
host.on("connect", () => { if (code) return; host.emit("create", { name: "Host", playerId: "host-" + Date.now().toString(36), avatar: "\u{1F451}" }); });
host.on("joined", (d) => { code = d.code; console.log("CODE=" + code);
  for (let i = 0; i < N - 2; i++) { const c = mk(); const nm = ["Chip", "Robo", "Dee", "Tess", "Mo"][i] || "Pal" + i;
    c.on("connect", () => c.emit("join", { code, name: nm, playerId: nm.toLowerCase() + "-" + Date.now().toString(36), avatar: ["\u{1F43C}","\u{1F98A}","\u{1F42F}","\u{1F438}","\u{1F419}"][i] }));
    c.on("state", ({ room }) => { if (process.env.SUBMIT && room && room.phase === "write" && c.sub !== room.round) { c.sub = room.round; setTimeout(() => c.emit("submit", { text: ["a second remote", "my mother-in-law", "separate blankets"][i] || "snacks" }), 800 + i * 400); } }); }
});
host.on("err", (e) => console.log("err:", e));
host.on("state", ({ room }) => {
  if (!room) return;
  if (room.status === "lobby" && room.players.length >= N && !started) { started = true; console.log("players:", room.players.map((p) => p.name).join(", ")); setTimeout(() => host.emit("start", {}), 800); }
  else if (room.status !== "lobby" && !global.a) { global.a = true; console.log("STARTED"); }
  if (process.env.SUBMIT && room.phase === "write" && host.sub !== room.round) { host.sub = room.round; setTimeout(() => host.emit("submit", { text: "never saying 'calm down'" }), 600); }
});
setTimeout(() => process.exit(0), Number(process.env.KEEP_MS || 240000));
