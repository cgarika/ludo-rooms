/* Plus Four 12+ card hand at phone width in in-app mode: join a hosted 3p room, draw on every turn until the hand is big, shoot on our turn. */
const { chromium } = require("playwright"); const { spawn } = require("child_process"); const OUT = process.argv[2];
(async () => {
  const host = spawn("node", [".host-any.tmp.js", "/eights", "3", "draw"], { cwd: __dirname, env: { ...process.env, KEEP_MS: "400000" } });
  let code = null; host.stdout.on("data", d => { const m = String(d).match(/CODE=([A-Z0-9]+)/); if (m) code = m[1]; });
  for (let i = 0; i < 40 && !code; i++) await new Promise(r => setTimeout(r, 500));
  if (!code) { console.log("no code"); host.kill(); process.exit(1); }
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); const p = await ctx.newPage(); p.setDefaultTimeout(8000);
  await p.goto("https://needasix.com/eights/", { waitUntil: "domcontentloaded" }); await p.waitForTimeout(1200);
  await require("./.inapp.tmp.js")(p);
  await p.fill("#nameIn", "Tester"); await p.fill("#codeIn", code); await p.click("#joinBtn"); await p.waitForTimeout(2500);
  console.log("joined", code, await p.evaluate(() => document.getElementById("game").classList.contains("hidden") ? "lobby" : "game"));
  let done = false; const t0 = Date.now();
  while (!done && Date.now() - t0 < 300000) {
    const st = await p.evaluate(() => { const r = S.room; if (!r) return null; return { status: r.status, phase: r.phase, mine: r.turn === S.mySeat, n: document.querySelectorAll("#hand .hcard").length, legal: (r.yourLegal || []).length }; });
    if (st && st.status !== "playing" && st.status !== "lobby") { console.log("game ended", st.status); break; }
    if (st && st.status === "playing" && st.mine) { console.log("turn hand=" + st.n + " phase=" + st.phase);
      if (st.n >= 12) { await p.waitForTimeout(600); const info = await p.evaluate(() => ({ n: document.querySelectorAll("#hand .hcard").length, legal: document.querySelectorAll("#hand .hcard.legal").length, hint: document.getElementById("actionhint").textContent, scrollW: document.getElementById("hand").scrollWidth, clientW: document.getElementById("hand").clientWidth, pageW: document.documentElement.scrollWidth, viewW: innerWidth, gameW: document.getElementById("game").getBoundingClientRect().width })); console.log("big hand", JSON.stringify(info));
        const dbg = await p.evaluate(() => { const h = document.getElementById("hand"); const jd = h.querySelector(".hcard.justdrawn"); const r0 = { scrollLeft: h.scrollLeft, jd: !!jd, jdLeft: jd ? jd.offsetLeft : null, jdIdx: jd ? [...h.children].indexOf(jd) : null, key: (typeof handScrollKey !== "undefined") ? handScrollKey : "n/a", ov: getComputedStyle(h).overflowX }; if (jd) { jd.scrollIntoView({ inline: "center", block: "nearest" }); r0.afterManual = h.scrollLeft; } return r0; });
        console.log("scroll dbg", JSON.stringify(dbg)); await p.waitForTimeout(400); await p.screenshot({ path: OUT + "/web-eights-12cards.png" }); done = true; break; }
      await p.evaluate((drawn) => { const el = document.getElementById(drawn ? "keepBtn" : "drawpile"); if (el) el.click(); }, st.phase === "drawn");
      await p.waitForTimeout(700);
    }
    await p.waitForTimeout(300);
  }
  if (!done) console.log("never reached 12 cards");
  await b.close(); host.kill(); process.exit(0);
})().catch(e => { console.log("FAIL", e.message.split("\n")[0]); process.exit(1); });
