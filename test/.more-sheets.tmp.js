/* Shell: More → Game guides / About / Privacy sheets and the game page's How to play, from the built bundle. */
const { chromium } = require("playwright"); const { spawn } = require("child_process"); const OUT = process.argv[2];
(async () => {
  const srv = spawn("npx", ["vite", "preview", "--host", "127.0.0.1", "--port", "4178", "--strictPort"], { cwd: process.env.HOME + "/Documents/Projects/gamenest-app", stdio: "ignore" });
  await new Promise(r => setTimeout(r, 3500));
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); const p = await ctx.newPage(); p.setDefaultTimeout(8000); const errs = [];
  p.on("pageerror", e => errs.push(e.message.split("\n")[0]));
  try {
    await p.goto("http://127.0.0.1:4178/", { waitUntil: "domcontentloaded", timeout: 25000 }); await p.waitForTimeout(2500);
    const inp = await p.$("input"); if (inp) { await inp.fill("Chanu"); await p.waitForTimeout(200); await p.click("text=Let's play"); await p.waitForTimeout(900); }
    await p.click('.tab:has-text("More")'); await p.waitForTimeout(700); await p.screenshot({ path: OUT + "/more-v2.png" });
    for (const [label, file] of [["About GameNest", "sheet-about"], ["Privacy", "sheet-privacy"]]) {
      await p.click(`.row:has-text("${label}")`); await p.waitForTimeout(700); await p.screenshot({ path: OUT + "/" + file + ".png" });
      await p.evaluate(() => document.querySelectorAll(".sheet-backdrop").forEach(b => b.click())); await p.waitForTimeout(600);
    }
    await p.click('.tab:has-text("Home")'); await p.waitForTimeout(600); await p.click('.poster[aria-label="Snakebite"]'); await p.waitForTimeout(800);
    await p.click('text=How to play'); await p.waitForTimeout(700); await p.screenshot({ path: OUT + "/sheet-guide-snakes.png" });
  } catch (e) { console.log("FAIL", e.message.split("\n")[0]); }
  console.log("errors", errs); await b.close(); srv.kill(); process.exit(0);
})();
