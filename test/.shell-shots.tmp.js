const { chromium } = require("playwright"); const { spawn } = require("child_process"); const OUT = process.argv[2];
(async () => {
  const srv = spawn("npx", ["vite", "preview", "--host", "127.0.0.1", "--port", "4177", "--strictPort"], { cwd: process.env.HOME + "/Documents/Projects/gamenest-app", stdio: "ignore" });
  await new Promise(r => setTimeout(r, 3500));
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await ctx.newPage(); p.setDefaultTimeout(6000); const errs = [];
  p.on("pageerror", e => errs.push("PAGEERROR " + e.message)); p.on("console", m => { if (m.type() === "error" && !/favicon/.test(m.text())) errs.push(m.text().slice(0, 100)); });
  try {
    await p.goto("http://127.0.0.1:4177/", { waitUntil: "domcontentloaded", timeout: 25000 }); await p.waitForTimeout(3000);
    await p.screenshot({ path: OUT + "/shell-firstrun.png" });
    const inp = await p.$("input"); if (inp) { await inp.fill("Chanu"); const btn = await p.$("text=Let's play"); if (btn) await btn.click(); await p.waitForTimeout(900); }
    await p.screenshot({ path: OUT + "/shell-home.png" });
    for (const t of ["Wins", "More"]) { await p.click(`.tab:has-text("${t}")`); await p.waitForTimeout(900); await p.screenshot({ path: OUT + `/shell-${t.toLowerCase()}.png` }); }
    console.log("wins labels", await p.evaluate(() => { const out = []; document.querySelectorAll(".trophy").forEach(t => { const r = t.getBoundingClientRect(); const s = t.querySelector("span").getBoundingClientRect(); out.push(`${t.querySelector("span").textContent}:${Math.round(r.width)}w sp=${Math.round(s.width)} ${s.right <= r.right + 1 ? "ok" : "CLIP"}`); }); return out.join(" | "); }));
    console.log("more rows", await p.evaluate(() => [...document.querySelectorAll(".row b")].map(b => b.textContent).join(" | ")));
    console.log("warm frame", await p.evaluate(() => { const w = document.querySelector(".play.warm"); if (!w) return "none"; const cs = getComputedStyle(w); return `opacity=${cs.opacity} z=${cs.zIndex} app-z=${getComputedStyle(document.getElementById("app")).zIndex}`; }));
  } catch (e) { console.log("FAIL", e.message.split("\n")[0]); }
  console.log("errors", errs); await b.close(); srv.kill(); process.exit(0);
})();
