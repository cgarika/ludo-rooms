/* Does the Plus Four history strip retire in WebKit (the app's engine)? Load the BUNDLED client from disk with the bridge on, host a live room, add a bot, start, and sample the strip's opacity after each bot play. */
const { webkit } = require("playwright"); const path = require("path"); const OUT = process.argv[2];
const FILE = path.join(process.env.HOME, "Documents/Projects/gamenest-app/public/games/eights/index.html");
(async () => {
  const b = await webkit.launch(); const p = await b.newPage({ viewport: { width: 393, height: 852 } }); const errs = []; p.on("pageerror", e => errs.push(e.message.split("\n")[0]));
  await p.goto(`file://${FILE}?gn=1&name=QA&av=%F0%9F%A6%8A&create=1`, { waitUntil: "load" }); await p.waitForTimeout(3000);
  await p.evaluate(() => document.getElementById("addBotBtn")?.click()); await p.waitForTimeout(600); await p.evaluate(() => document.getElementById("addBotBtn")?.click()); await p.waitForTimeout(600);
  await p.evaluate(() => document.getElementById("startBtn")?.click()); await p.waitForTimeout(2000);
  console.log("status", await p.evaluate(() => S.room && S.room.status), "errors", errs);
  let last = null; const t0 = Date.now(); let samples = 0;
  while (Date.now() - t0 < 60000 && samples < 3) {
    const cur = await p.evaluate(() => S.room && S.room.log);
    if (cur && cur !== last && /played/.test(cur)) { const t = Date.now(); const series = []; for (let k = 0; k < 8; k++) { series.push(await p.evaluate(() => ({ op: getComputedStyle(document.getElementById("log")).opacity, fresh: document.getElementById("log").classList.contains("fresh") }))); await p.waitForTimeout(700); } console.log("log", JSON.stringify(cur), "opacity over 5s:", series.map(s => s.op + (s.fresh ? "F" : "")).join(" ")); samples++; }
    last = cur || last; await p.waitForTimeout(150);
  }
  await p.evaluate(() => { try { socket.emit("leave"); } catch (e) {} }); await b.close();
})().catch(e => { console.log("FAIL", e.message.split("\n")[0]); process.exit(1); });
