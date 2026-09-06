/* Does a bundled client rejoin its room after the socket drops (background → foreground)? Loads the bundled client with the
   bridge on, hosts a live room with a bot, then kills and reopens the socket and checks the seat is reclaimed. */
const { chromium } = require("playwright"); const path = require("path");
const ROOT = path.join(process.env.HOME, "Documents/Projects/gamenest-app/public/games");
(async () => {
  const b = await chromium.launch(); let fails = 0;
  for (const slug of ["eights", "snakes", "rummy", "mafia", "spies", "punchlines", "ludo"]) {
    const p = await b.newPage({ viewport: { width: 393, height: 852 } }); const errs = []; p.on("pageerror", e => errs.push(e.message.split("\n")[0]));
    await p.goto(`file://${ROOT}/${slug}/index.html?gn=1&name=QA&av=%F0%9F%A6%8A&create=1`, { waitUntil: "load" }); await p.waitForTimeout(3500);
    const before = await p.evaluate(() => ({ code: S.room && S.room.code, seat: S.mySeat, status: S.room && S.room.status }));
    await p.evaluate(() => { socket.disconnect(); }); await p.waitForTimeout(800);
    const during = await p.evaluate(() => socket.connected);
    await p.evaluate(() => { socket.connect(); }); await p.waitForTimeout(2500);
    const after = await p.evaluate(() => ({ code: S.room && S.room.code, seat: S.mySeat, connected: socket.connected, me: S.room && S.room.players && S.room.players[S.mySeat] ? S.room.players[S.mySeat].connected : null, status: S.room && S.room.status }));
    const ok = !!before.code && before.code === after.code && after.seat === before.seat && after.connected && after.me !== false && errs.length === 0;
    if (!ok) fails++;
    console.log(`${ok ? "✓" : "✗"} ${slug.padEnd(10)} room ${before.code} seat ${before.seat} → dropped(connected=${during}) → rejoined: code=${after.code} seat=${after.seat} connected=${after.connected} me.connected=${after.me}${errs.length ? " errors: " + errs.join(" | ") : ""}`);
    try { await p.evaluate(() => socket.emit("leave")); } catch (_) {} await p.close();
  }
  await b.close(); console.log(fails ? `RECONNECT CHECK: ${fails} FAILED` : "RECONNECT CHECK: PASS"); process.exit(fails ? 1 : 0);
})();
