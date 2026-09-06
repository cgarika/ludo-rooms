/* Mid-turn 6p Ludo frame on the live web client at phone size with the in-app class: join a hosted room, roll on our turns, shoot the "choose a pawn" state. */
const { chromium } = require("playwright"); const { spawn } = require("child_process"); const OUT = process.argv[2];
(async () => {
  const host = spawn("node", [".host-any.tmp.js", "/ludo", "6", "auto"], { cwd: __dirname, env: { ...process.env, KEEP_MS: "660000" } });
  let code = null; host.stdout.on("data", d => { const m = String(d).match(/CODE=([A-Z0-9]+)/); if (m) code = m[1]; });
  for (let i = 0; i < 40 && !code; i++) await new Promise(r => setTimeout(r, 500));
  if (!code) { console.log("no code"); host.kill(); process.exit(1); }
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); const p = await ctx.newPage(); p.setDefaultTimeout(8000);
  await p.goto("https://needasix.com/ludo/", { waitUntil: "domcontentloaded" }); await p.waitForTimeout(1200);
  await p.evaluate(() => { document.documentElement.classList.add("in-app"); const st = document.createElement("style"); st.textContent = "html.in-app #lobby .wordmark, html.in-app #game .wordmark, html.in-app .themebtn, html.in-app #leaveGameBtn, html.in-app #leaveLobbyBtn, html.in-app #game .hint, html.in-app #rulesfoot{display:none!important} html.in-app #game{padding-top:2px}"; document.head.appendChild(st); });
  await p.fill("#nameIn", "Tester"); await p.fill("#codeIn", code); await p.click("#joinBtn"); await p.waitForTimeout(2500);
  console.log("joined", code, await p.evaluate(() => document.getElementById("game").classList.contains("hidden") ? "lobby" : "game"));
  let done = false; const t0 = Date.now();
  while (!done && Date.now() - t0 < 600000) {
    const st = await p.evaluate(() => { const r = (typeof S !== "undefined") && S.room; if (!r) return null; return { status: r.status, phase: r.phase, mine: r.turn === S.mySeat, die: r.die, roll: !document.getElementById("rollBtn").classList.contains("hidden") }; });
    if (st && st.status === "playing" && st.mine && st.phase === "roll" && st.roll) { await p.click("#rollBtn"); let st2 = null;
      for (let k = 0; k < 25; k++) { await p.waitForTimeout(100); st2 = await p.evaluate(() => ({ phase: S.room.phase, die: S.room.die, mine: S.room.turn === S.mySeat, info: document.getElementById("turninfo").textContent, halos: document.querySelectorAll("#boardwrap [stroke-dasharray]").length, quiet: document.getElementById("dicehub").classList.contains("quiet") })); if (st2.mine && st2.phase === "move") { for (let j = 0; j < 30; j++) { await p.waitForTimeout(100); st2.halos = await p.evaluate(() => document.querySelectorAll("#boardwrap [stroke-dasharray]").length); if (st2.halos > 0) break; } for (let j = 0; j < 30; j++) { const busy = await p.evaluate(() => document.getAnimations().some(a => a.playState === "running" && a.effect && a.effect.target && a.effect.target.closest && a.effect.target.closest("#dicehub"))); if (!busy) break; await p.waitForTimeout(100); } await p.waitForTimeout(250); break; } if (!st2.mine) break; }
      console.log("rolled", JSON.stringify(st2));
      if (st2.mine && st2.phase === "move") { await p.screenshot({ path: OUT + "/web-ludo6-midturn.png" }); done = true; } }
    await p.waitForTimeout(400);
  }
  if (!done) { await p.screenshot({ path: OUT + "/web-ludo6-midturn.png" }); console.log("no move-phase frame in time (never rolled a 6?) — saved current frame"); }
  await b.close(); host.kill(); process.exit(0);
})().catch(e => { console.log("FAIL", e.message.split("\n")[0]); process.exit(1); });
