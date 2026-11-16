/* Every sticker avatar GameNest 2.0 offers reaches the other players as itself (the lead, 2026-11-16): node test/avatars.js
   The app's 20 avatars (its Content/Data/games.json "avatars") were outside this server's list, so in Ludo 15 of them reached
   everyone else as a plain smiley. Starts its own server on TEST_PORT (default 5593; never 3111-3126), with its records in a folder
   of its own that it removes at the end, and checks over real sockets, the way the app does it: (1) a host who makes a room with each
   of the 20 is seated with that avatar, and a second player who joins sees the host's avatar unchanged; (2) v1's twelve still pass;
   (3) anything outside the list still becomes the smiley. */
"use strict";
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { io } = require("socket.io-client");

const PORT = Number(process.env.TEST_PORT || 5593);
if (PORT >= 3111 && PORT <= 3126) { console.error("refusing " + PORT + ": 3111-3126 are the live servers"); process.exit(2); }
const APP = ["🦊", "🐼", "🐸", "🐙", "🦁", "👻", "🐯", "🐧", "🐤", "🐲", "🐵", "🦄", "🦖", "🐨", "🦀", "🦉", "🦎", "🦈", "🐝", "🌵"];
const V1 = ["😎", "🤓", "👑", "🐯", "🐼", "🦊", "👽", "🤖", "🍕", "🐸", "🦄", "💩"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = (fn, what, ms = 20000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const tick = () => { const v = fn(); if (v) return res(v); if (Date.now() - t0 > ms) return rej(new Error("timed out waiting for " + what)); setTimeout(tick, 10); };
  tick();
});
const get = (p) => new Promise((res, rej) => {
  const req = http.get({ host: "127.0.0.1", port: PORT, path: p }, (r) => { r.resume(); r.on("end", () => res(r.statusCode)); });
  req.on("error", rej);
});
const pid = () => "p" + Math.random().toString(36).slice(2, 10);
const portFree = () => new Promise((res) => {
  const c = net.connect({ host: "127.0.0.1", port: PORT });
  c.once("connect", () => { c.destroy(); res(false); });
  c.once("error", () => res(true));
});
/* The seat list a state carries, wherever the game keeps it: the first array called players (or seats) whose entries have a name. */
function seatsOf(x, depth = 0) {
  if (!x || typeof x !== "object" || depth > 3) return null;
  for (const k of ["players", "seats"]) if (Array.isArray(x[k]) && x[k].some((p) => p && typeof p === "object" && "name" in p)) return x[k];
  for (const v of Object.values(x)) { const r = seatsOf(v, depth + 1); if (r) return r; }
  return null;
}

async function main() {
  let free = false;
  for (let i = 0; i < 100 && !free; i++) { free = await portFree(); if (!free) await sleep(100); }
  assert(free, "port " + PORT + " is in use: another server is listening on it");
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "avatars-test-"));
  const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT: String(PORT), RANK_DIR: data, STATS_DIR: data, DATA_DIR: data }, stdio: "ignore" });
  let gone = false;
  srv.on("exit", () => { gone = true; });
  const socks = [];
  const open = async () => {
    const s = io(`http://127.0.0.1:${PORT}`, { transports: ["websocket"], forceNew: true, reconnection: false });
    socks.push(s);
    s.last = null; s.refusals = [];
    s.onAny((ev, ...args) => { if (ev === "err") s.refusals.push(args[0]); for (const a of args) if (seatsOf(a)) s.last = a; });
    s.on("joined", (j) => { s.joined = j; });
    await wait(() => s.connected, "a socket to connect");
    return s;
  };
  // The avatar the host is seated with, as a second player who joins the room sees it.
  const seenBy = async (avatar) => {
    const host = await open();
    host.emit("create", { name: "Hosta", playerId: pid(), avatar });
    await wait(() => host.joined || host.refusals.length, "the reply to create");
    assert(host.joined, "create was refused: " + JSON.stringify(host.refusals));
    const guest = await open();
    guest.emit("join", { code: host.joined.code, name: "Guesta", playerId: pid(), avatar: "🦁" });
    await wait(() => guest.last && seatsOf(guest.last).some((p) => p.name === "Hosta"), "the guest to see the host");
    const a = seatsOf(guest.last).find((p) => p.name === "Hosta").avatar;
    host.close(); guest.close();
    return a;
  };
  let passed = 0;
  try {
    let up = false;
    for (let i = 0; i < 300 && !up && !gone; i++) { try { await get("/"); up = true; } catch { await sleep(100); } }
    assert(up && !gone, "the server did not come up");
    for (const a of APP) assert.strictEqual(await seenBy(a), a, "the app's avatar " + a + " reached the other player as something else");
    console.log("  ok the app's 20 avatars reach the other player as themselves"); passed++;
    for (const a of V1) assert.strictEqual(await seenBy(a), a, "v1's avatar " + a + " no longer passes");
    console.log("  ok v1's 12 avatars still pass"); passed++;
    assert.strictEqual(await seenBy("🔫"), "\u{1F642}", "an avatar outside the list is not the smiley");
    assert.strictEqual(await seenBy("<b>"), "\u{1F642}", "a non-emoji avatar is not the smiley");
    console.log("  ok anything else is still the smiley"); passed++;
  } finally {
    for (const s of socks) { try { s.close(); } catch {} }
    srv.kill();
    await wait(() => gone, "the test server to stop", 5000).catch(() => {});
    fs.rmSync(data, { recursive: true, force: true });
  }
  console.log(`avatars: ${passed} passed`);
}
main().catch((e) => { console.error("FAIL " + e.message); process.exit(1); });
