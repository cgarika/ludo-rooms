const { chromium } = require("playwright"); const { spawn } = require("child_process"); const OUT = process.argv[2];
const log = (...a) => { process.stdout.write(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ") + "\n"); };
(async () => {
  const srv = spawn("node", ["server.js"], { cwd: process.env.HOME + "/Documents/Projects/mafia-rooms", env: { ...process.env, PORT: "3213", REVEAL_MS: "6000" }, stdio: "ignore" });
  await new Promise(r => setTimeout(r, 1200));
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2 }); p.setDefaultTimeout(4000); const errs = [];
  p.on("pageerror", e => errs.push("PAGEERROR " + e.message)); p.on("console", m => { if (m.type() === "error") errs.push(m.text().slice(0, 120)); });
  try {
    await p.goto("http://127.0.0.1:3213/", { waitUntil: "load" }); await p.waitForTimeout(800); log("loaded");
    await p.fill("#nameIn", "Tester"); await p.click("#createBtn"); await p.waitForTimeout(1200); log("created");
    for (let i = 0; i < 5; i++) { await p.evaluate(() => document.getElementById("addBotBtn").click()); await p.waitForTimeout(300); }
    log("bots", await p.evaluate(() => document.getElementById("pcount").textContent));
    await p.evaluate(() => document.getElementById("startBtn").click()); await p.waitForTimeout(1500); log("start clicked");
    log("after start", await p.evaluate(() => ({ game: !document.getElementById("game").classList.contains("hidden"), rc: document.getElementById("rolecard").className, phase: document.getElementById("phaseBig").textContent, timer: document.getElementById("timerNum").textContent })));
    await p.screenshot({ path: OUT + "/mafia-web-reveal.png", timeout: 8000 }); log("shot1");
    await p.waitForTimeout(7000);
    log("after 8s", await p.evaluate(() => ({ rc: document.getElementById("rolecard").className, h: document.querySelector(".rolecard .inner").getBoundingClientRect().height, front: document.querySelector(".rolecard .face.front").innerText.replace(/\n/g, " | ") })));
    await p.screenshot({ path: OUT + "/mafia-web-peeked.png", timeout: 8000 }); log("shot2");
  } catch (e) { log("FAIL", e.message.split("\n")[0]); }
  log("errors", errs); await b.close(); srv.kill(); process.exit(0);
})();
