/* Ludo: GameNest Plus's boards over real sockets (2026-10-17): node test/plus_board.js (starts its own server on
   TEST_PORT, default 3296). */
const assert = require("assert");
const { spawn } = require("child_process");
const path = require("path");
const { io } = require("socket.io-client");

const PORT = Number(process.env.TEST_PORT || 3296);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = (fn, ms = 6000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const tick = () => { const v = fn(); if (v) return res(v); if (Date.now() - t0 > ms) return rej(new Error("timeout")); setTimeout(tick, 15); };
  tick();
});

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: { ...process.env, PORT }, stdio: "ignore" });
  await sleep(700);
  const socks = [];
  let passed = 0;
  const ok = (m) => { passed++; console.log("  ok " + m); };
  try {
    const host = async (plus) => {
      const s = io(`http://127.0.0.1:${PORT}`, { transports: ["websocket"], forceNew: true });
      socks.push(s);
      s.st = null; s.refused = null;
      s.on("state", (m) => { s.st = m.room || m; });
      s.on("refusal", (m) => { s.refused = m; });
      s.emit("create", { name: "Host", playerId: "h" + Math.random(), plus });
      await wait(() => s.st && s.st.code);
      return s;
    };
    const plain = await host(false);
    assert.strictEqual(plain.st.board, "classic");
    plain.emit("settings", { board: "candy" });
    await wait(() => plain.refused);
    assert.strictEqual(plain.refused.code, "plus");
    assert.strictEqual(plain.st.board, "classic");
    ok("an ordinary room: the classic board, a Plus one refused (code plus)");

    const plus = await host(true);
    plus.emit("settings", { board: "galaxy" });
    await wait(() => plus.st.board === "galaxy");
    ok("a Plus room: the host picks Galaxy, and the state says so");
    plus.emit("settings", { board: "unicorn" });
    await sleep(200);
    assert.strictEqual(plus.st.board, "galaxy");
    ok("an unknown board is ignored");
    plus.emit("settings", { board: "classic" });
    await wait(() => plus.st.board === "classic");
    ok("back to the classic board");
  } finally {
    socks.forEach((s) => s.close());
    srv.kill();
  }
  console.log(`plus boards: all ${passed} passed`);
}
main().catch((e) => { console.error("FAIL " + e.message); process.exit(1); });
