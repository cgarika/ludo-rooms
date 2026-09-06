/* Word Spies spymaster board at phone width in in-app mode: host a 4-human room (3 sockets + this page), start, and keep re-rolling rooms until this seat is a spymaster. */
const { chromium } = require("playwright"); const { spawn } = require("child_process"); const OUT = process.argv[2];
const inapp = "html.in-app #lobby .wordmark, html.in-app #game .wordmark, html.in-app #leaveGameBtn, html.in-app #leaveLobbyBtn, html.in-app #game .hint{display:none!important} html.in-app #game{padding-top:2px}";
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); const p = await ctx.newPage(); p.setDefaultTimeout(8000);
  for (let attempt = 1; attempt <= 8; attempt++) {
    const host = spawn("node", [".humans-host.tmp.js", "/spies", "4"], { cwd: __dirname, env: { ...process.env, KEEP_MS: "120000" } });
    let code = null; host.stdout.on("data", d => { const m = String(d).match(/CODE=([A-Z0-9]+)/); if (m) code = m[1]; });
    for (let i = 0; i < 40 && !code; i++) await new Promise(r => setTimeout(r, 500));
    if (!code) { host.kill(); continue; }
    await p.goto("https://needasix.com/spies/", { waitUntil: "domcontentloaded" }); await p.waitForTimeout(1000);
    await p.evaluate((css) => { document.documentElement.classList.add("in-app"); const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st); localStorage.setItem("wsHelpSeen", "1"); }, inapp);
    await p.fill("#nameIn", "Tester"); await p.fill("#codeIn", code); await p.click("#joinBtn");
    let st = null; for (let i = 0; i < 30; i++) { await p.waitForTimeout(500); st = await p.evaluate(() => S.room && S.room.status === "playing" ? { spy: !!S.room.youAreSpymaster, team: S.room.yourTeam, turn: S.room.turnTeam } : null); if (st) break; }
    console.log("attempt", attempt, code, JSON.stringify(st));
    if (st && st.spy) { await p.evaluate(() => document.getElementById("helpwrap")?.classList.add("hidden")); await p.waitForTimeout(900); await p.screenshot({ path: OUT + "/web-spies-spymaster.png" }); console.log("SPYMASTER FRAME"); host.kill(); break; }
    await p.evaluate(() => { try { socket.emit("leave"); } catch (e) {} localStorage.removeItem("wsRoom"); }); host.kill(); await p.waitForTimeout(800);
  }
  await b.close(); process.exit(0);
})().catch(e => { console.log("FAIL", e.message.split("\n")[0]); process.exit(1); });
