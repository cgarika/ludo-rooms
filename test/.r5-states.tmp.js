/* Round-5 evidence states on the live web clients in in-app mode. node .r5-states.tmp.js <which> <outdir>   which = rummy | snakes8 | eights | spies */
const { chromium } = require("playwright"); const { spawn } = require("child_process"); const applyInApp = require("./.inapp.tmp.js");
const [WHICH, OUT] = process.argv.slice(2); const wait = (ms) => new Promise(r => setTimeout(r, ms));
function host(args, env = {}) { const h = spawn("node", args, { cwd: __dirname, env: { ...process.env, KEEP_MS: "400000", ...env } }); h.code = null; h.stdout.on("data", d => { const m = String(d).match(/CODE=([A-Z0-9]+)/); if (m) h.code = m[1]; }); return h; }
async function join(p, path, code) { await p.goto(`https://needasix.com/${path}/`, { waitUntil: "domcontentloaded" }); await wait(1000); await p.evaluate(() => localStorage.setItem("wsHelpSeen", "1")); await applyInApp(p); await p.fill("#nameIn", "Tester"); await p.fill("#codeIn", code); await p.click("#joinBtn"); await wait(2500); }
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); const p = await ctx.newPage(); p.setDefaultTimeout(8000);
  let h;
  try {
    if (WHICH === "rummy") {
      h = host([".host-any.tmp.js", "/rummy", "3"]); while (!h.code) await wait(400); await join(p, "rummy", h.code);
      const t0 = Date.now(); let done = false;
      while (!done && Date.now() - t0 < 180000) { const st = await p.evaluate(() => S.room && S.room.status === "playing" ? { mine: S.room.turn === S.mySeat, phase: S.room.phase, tip: document.getElementById("actionhint").textContent } : null);
        if (st && st.mine && st.phase === "draw") { console.log("pre-draw", JSON.stringify(st)); await p.evaluate(() => document.getElementById("drawpile").click()); await wait(900);
          const st2 = await p.evaluate(() => ({ phase: S.room.phase, tip: document.getElementById("actionhint").textContent, discardDisabled: document.getElementById("discardBtn").disabled, declareDisabled: document.getElementById("declareBtn").disabled, n: document.querySelectorAll("#loose .pc, .grp .pc").length }));
          console.log("post-draw", JSON.stringify(st2)); await p.screenshot({ path: OUT + "/web-rummy-after-draw.png" }); done = true; }
        await wait(400); }
      if (!done) console.log("never got a draw turn");
    } else if (WHICH === "snakes8") {
      h = host([".host-any.tmp.js", "/snakes", "8", "auto"]); while (!h.code) await wait(400); await join(p, "snakes", h.code);
      const t0 = Date.now(); let done = false;
      while (!done && Date.now() - t0 < 180000) { const st = await p.evaluate(() => S.room && S.room.status === "playing" ? { mine: S.room.turn === S.mySeat, n: S.room.players.length, roll: !document.getElementById("rollBtn").disabled } : null);
        if (st && st.mine && st.roll) { await wait(300); const geo = await p.evaluate(() => { const r = document.getElementById("rollBtn").getBoundingClientRect(); return { rollTop: Math.round(r.top), rollBottom: Math.round(r.bottom), viewH: innerHeight, scrollY: Math.round(scrollY) }; }); console.log("active roll", JSON.stringify({ ...st, ...geo })); await p.screenshot({ path: OUT + "/web-snakes-8p-your-roll.png" }); done = true; }
        await wait(300); }
      if (!done) console.log("never got our roll");
    } else if (WHICH === "eights") {
      h = host([".host-any.tmp.js", "/eights", "3", "draw"]); while (!h.code) await wait(400); await join(p, "eights", h.code);
      let last = await p.evaluate(() => S.room && S.room.log); const t0 = Date.now(); let done = false;
      while (!done && Date.now() - t0 < 120000) { const cur = await p.evaluate(() => S.room && S.room.log); if (cur && cur !== last && /played/.test(cur)) { const o0 = await p.evaluate(() => getComputedStyle(document.getElementById("log")).opacity); await p.screenshot({ path: OUT + "/web-eights-strip-t0.png" }); await wait(3000); const o3 = await p.evaluate(() => getComputedStyle(document.getElementById("log")).opacity); await p.screenshot({ path: OUT + "/web-eights-strip-t3.png" }); console.log("strip", JSON.stringify({ log: cur, opacityAt0: o0, opacityAt3s: o3 })); done = true; } last = cur || last; await wait(150); }
      if (!done) console.log("no bot play seen");
    } else if (WHICH === "spies") {
      for (let attempt = 1; attempt <= 8; attempt++) {
        h = host([".humans-host.tmp.js", "/spies", "4"], { KEEP_MS: "200000" }); while (!h.code) await wait(400); await join(p, "spies", h.code);
        let st = null; for (let i = 0; i < 30; i++) { await wait(500); st = await p.evaluate(() => S.room && S.room.status === "playing" ? { spy: !!S.room.youAreSpymaster, team: S.room.yourTeam, turn: S.room.turnTeam, phase: S.room.phase } : null); if (st) break; }
        console.log("attempt", attempt, h.code, JSON.stringify(st));
        if (st && st.spy) { const t0 = Date.now(); let ok = false; while (Date.now() - t0 < 150000) { const s2 = await p.evaluate(() => ({ turn: S.room.turnTeam, phase: S.room.phase, team: S.room.yourTeam, banner: document.getElementById("rolechip").textContent })); if (s2.turn === s2.team && s2.phase === "clue") { await wait(600); console.log("active spymaster", JSON.stringify(s2)); await p.screenshot({ path: OUT + "/web-spies-spymaster-active.png" }); ok = true; break; } await wait(700); }
          if (!ok) console.log("our clue turn never came"); h.kill(); break; }
        await p.evaluate(() => { try { socket.emit("leave"); } catch (e) {} }); h.kill(); await wait(800);
      }
    }
  } catch (e) { console.log("FAIL", e.message.split("\n")[0]); }
  if (h) h.kill(); await b.close(); process.exit(0);
})();
