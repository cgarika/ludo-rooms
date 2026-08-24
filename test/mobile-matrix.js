/* Mobile device-matrix suite (Playwright) against the LIVE deployment.
   Run from test/:  node mobile-matrix.js     (BASE=https://needasix.com by default)
   Screenshots + mobile-results.json land in $SHOTS or test/shots-mobile.

   - iPhones/iPads run on WebKit (Safari engine), Androids on Chromium.
   - Full flow per device: create → add bot → set tokens → start → roll →
     tap glowing piece → chat + sticker → theme toggle → join voice (mock mic).
   - iPads additionally run a landscape core flow.
   - Per-device 10-player round-board audit: pawn tap size measured from the
     rendered SVG scale (+ real [data-tok] bbox when a 6 shows up in time).
   - Throttled pass (slow-4G + 4x CPU) for iPhone 17 Pro Max + iPhone SE
     profiles — CDP throttling is Chromium-only, so those run the iPhone
     viewport/UA on Chromium (noted in results).
*/
const { chromium, webkit, devices } = require("playwright");
const fs = require("fs");
const BASE = process.env.BASE || "https://needasix.com";
const SHOTS = process.env.SHOTS || __dirname + "/shots-mobile";
fs.mkdirSync(SHOTS, { recursive: true });

const MATRIX = [
  { name: "iPhone 17 Pro Max", engine: "webkit", primary: true },
  { name: "iPhone 17", engine: "webkit" },
  { name: "iPhone SE", engine: "webkit" },
  { name: "Pixel 9 Pro XL", engine: "chromium" },
  { name: "Galaxy S24", engine: "chromium" },
  { name: "iPad Mini", engine: "webkit", landscape: "iPad Mini landscape" },
  { name: "iPad Pro 11", engine: "webkit", landscape: "iPad Pro 11 landscape" },
];

const results = [];   // {device, step, ok, note}
const issues = [];    // {severity, device, stage, text}
const timings = [];   // throttled-pass numbers
const shotIndex = []; // {device, label, file}
let curDev = "";
const rec = (step, ok, note = "") => {
  results.push({ device: curDev, step, ok, note });
  console.log(` ${ok ? "✓" : "✗"} [${curDev}] ${step}${note ? " — " + note : ""}`);
};
const issue = (severity, stage, text) => {
  issues.push({ severity, device: curDev, stage, text });
  console.log(` ⚑ [${curDev}] (${severity}) ${stage}: ${text}`);
};
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const shot = async (pg, label) => {
  const file = `${slug(curDev)}--${label}.jpg`;
  await pg.screenshot({ path: SHOTS + "/" + file, type: "jpeg", quality: 55 });
  shotIndex.push({ device: curDev, label, file });
};

/* overflow / tap-target audit; 44px = Apple HIG guideline, 24px = hard minimum */
async function audit(pg, stage) {
  const found = await pg.evaluate(() => {
    const out = [];
    const W = window.innerWidth, de = document.documentElement;
    if (de.scrollWidth > W + 1) out.push({ sev: "major", text: `page overflows horizontally: ${de.scrollWidth}px > ${W}px viewport` });
    const sels = "button, input, [data-tok], .avchip, .schip, .tokbtn, .chattoggle, .sendbtn, #voiceLeave";
    for (const el of document.querySelectorAll(sels)) {
      if (el.classList.contains("hidden") || (!(el instanceof SVGElement) && el.offsetParent === null)) continue;
      // skip controls inside the collapsed chat drawer — hidden behind the toggle by design
      const drawer = el.closest("#chatbody");
      if (drawer && !drawer.classList.contains("open")) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const name = `<${el.tagName.toLowerCase()}${el.id ? "#" + el.id : "." + ((el.getAttribute("class") || "").split(" ")[0] || "")}>` +
        ` "${(el.textContent || el.placeholder || "").trim().slice(0, 16)}"`;
      const sz = `${Math.round(r.width)}x${Math.round(r.height)}px`;
      if (r.width < 24 || r.height < 24) out.push({ sev: "major", text: `tap target below 24px hard minimum: ${name} ${sz}` });
      else if (r.width < 44 || r.height < 44) out.push({ sev: "minor", text: `tap target below 44px Apple guideline: ${name} ${sz}` });
      if (r.left < -1 || r.right > W + 1) {
        let scrollable = false;
        for (let a = el.parentElement; a; a = a.parentElement) {
          const cs = getComputedStyle(a);
          if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && a.scrollWidth > a.clientWidth + 1) { scrollable = true; break; }
        }
        if (!scrollable) out.push({ sev: "major", text: `control clipped horizontally: ${name} at ${Math.round(r.left)}..${Math.round(r.right)} (viewport ${W})` });
      }
      el.scrollIntoView({ block: "center" });
      const r2 = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r2.x + r2.width / 2, r2.y + r2.height / 2);
      if (hit && !el.contains(hit) && !hit.contains(el))
        out.push({ sev: "major", text: `unreachable — covered by <${hit.tagName.toLowerCase()}${hit.id ? "#" + hit.id : ""}>: ${name}` });
    }
    window.scrollTo(0, 0);
    return out;
  });
  const majors = found.filter((f) => f.sev === "major");
  found.forEach((f) => issue(f.sev, stage, f.text));
  if (!found.length) console.log(`   [${curDev}] ${stage}: audit clean`);
  return majors.length;
}

const S_eval = (pg, fn) => pg.evaluate(fn);
async function createRoom(pg, name) {
  await pg.goto(BASE, { waitUntil: "networkidle", timeout: 90000 });
  await pg.fill("#nameIn", name);
  await pg.tap("#createBtn");
  await pg.waitForSelector("#lobby:not(.hidden)", { timeout: 15000 });
}

async function rollUntilGlow(pg, capMs) {
  /* roll on our turns until a glowing (pickable) piece appears; returns {rolls, glowed} */
  const t0 = Date.now();
  let rolls = 0;
  while (Date.now() - t0 < capMs) {
    if (await pg.$("#boardwrap [data-tok]")) return { rolls, glowed: true };
    if (await pg.$("#rollBtn:not(.hidden)")) {
      await pg.tap("#rollBtn").catch(() => {});
      rolls++;
      await pg.waitForTimeout(800); // die spin
    } else await pg.waitForTimeout(400); // bot's turn
  }
  return { rolls, glowed: false };
}

async function fullFlow(pg) {
  await pg.goto(BASE, { waitUntil: "networkidle", timeout: 90000 });
  rec("load home", true);
  await shot(pg, "1-home");
  await audit(pg, "home");

  await pg.fill("#nameIn", "Tess");
  await pg.tap("#createBtn");
  await pg.waitForSelector("#lobby:not(.hidden)", { timeout: 15000 });
  rec("create room", true);

  await pg.tap("#addBotBtn");
  await pg.waitForFunction(() => document.getElementById("pcount").textContent.trim() === "2", null, { timeout: 8000 });
  rec("add bot", true);
  await shot(pg, "2-lobby-bot");
  await audit(pg, "lobby");

  await pg.tap('#tokrow [data-t="2"]');
  await pg.waitForFunction(() => S.room.tokenChoice === 2, null, { timeout: 5000 });
  rec("set tokens (2 per player)", true);

  await pg.tap("#startBtn");
  await pg.waitForSelector("#boardwrap svg", { timeout: 15000 });
  rec("start game", true);

  const { rolls, glowed } = await rollUntilGlow(pg, 100000);
  rec("roll die", rolls > 0, `${rolls} rolls`);
  if (glowed) {
    const before = await S_eval(pg, () => JSON.stringify(S.room.tokens[S.room.players[S.mySeat].color]));
    await pg.tap("#boardwrap [data-tok]").catch(() => {});
    await pg.waitForFunction(
      (b) => JSON.stringify(S.room.tokens[S.room.players[S.mySeat].color]) !== b, before, { timeout: 6000 }
    ).then(
      () => rec("tap glowing piece", true, "token moved"),
      () => rec("tap glowing piece", false, "tap did not move the token")
    );
  } else rec("tap glowing piece", false, `no 6 rolled in 100s window (${rolls} rolls)`);
  await pg.waitForTimeout(600);
  await shot(pg, "3-midgame");
  await audit(pg, "mid-game");

  await pg.tap("#chatToggle");
  await pg.waitForSelector("#chatbody.open", { timeout: 5000 }).catch(() => {});
  const chip = await pg.$(".schip");
  if (chip) {
    await chip.tap().catch(() => {});
    await pg.waitForFunction(() => (S.room.chat || []).some((c) => c.k === "s"), null, { timeout: 6000 })
      .then(() => rec("open chat + send sticker", true), () => rec("open chat + send sticker", false, "sticker not in room chat"));
  } else rec("open chat + send sticker", false, "no sticker chips visible");
  await shot(pg, "4-chat-open");
  await audit(pg, "chat-open");
  await pg.tap("#chatToggle").catch(() => {});

  const t0 = await S_eval(pg, () => document.documentElement.getAttribute("data-theme"));
  await pg.tap("#themeBtn");
  await pg.waitForTimeout(400);
  let t1 = await S_eval(pg, () => document.documentElement.getAttribute("data-theme"));
  if (t1 === t0) { await pg.tap("#themeBtn"); await pg.waitForTimeout(400); t1 = await S_eval(pg, () => document.documentElement.getAttribute("data-theme")); }
  rec("toggle theme", t1 !== t0, `${t0} → ${t1}`);

  await pg.tap("#voiceBtn");
  await pg.waitForFunction(() => VOICE.on === true && document.getElementById("voicewho").textContent.includes("in voice"), null, { timeout: 10000 })
    .then(async () => {
      rec("join voice (mock mic)", true, await S_eval(pg, () => document.getElementById("voicewho").textContent.trim()));
    }, () => rec("join voice (mock mic)", false, "VOICE.on never became true — mic permission?"));
  const pnl = await pg.$("#panel");
  const file = `${slug(curDev)}--5-voice.jpg`;
  await pnl.screenshot({ path: SHOTS + "/" + file, type: "jpeg", quality: 60 });
  shotIndex.push({ device: curDev, label: "5-voice", file });

  await pg.tap("#leaveGameBtn").catch(() => {});
  await pg.waitForSelector("#home:not(.hidden)", { timeout: 8000 }).catch(() => {});
}

async function roundBoardAudit(ctx) {
  const pg = await ctx.newPage();
  try {
    await createRoom(pg, "Ring");
    for (let i = 0; i < 9; i++) { await pg.tap("#addBotBtn"); await pg.waitForTimeout(250); }
    await pg.waitForFunction(() => document.getElementById("pcount").textContent.trim() === "10", null, { timeout: 10000 });
    await pg.tap("#startBtn");
    await pg.waitForSelector("#boardwrap svg", { timeout: 15000 });
    const m = await S_eval(pg, () => {
      const svg = document.querySelector("#boardwrap svg");
      const vb = svg.viewBox.baseVal;
      const scale = svg.getBoundingClientRect().width / vb.width;
      const baseR = Math.max(9, circCellR(S.room.cfg.M));
      return {
        mode: S.room.cfg.mode, players: S.room.players.length,
        boardPx: Math.round(svg.getBoundingClientRect().width),
        pawnPx: +(2 * baseR * scale).toFixed(1),
        hitPx: +(2 * (baseR + 14) * scale).toFixed(1),
      };
    });
    const comfy = m.hitPx >= 44 ? "comfortable (≥44px)" : m.hitPx >= 32 ? "usable but snug" : "too small";
    rec("10p round board pawn size", m.hitPx >= 32,
      `${m.mode} board ${m.boardPx}px wide; pawn ${m.pawnPx}px, tap zone ${m.hitPx}px → ${comfy}`);
    if (m.hitPx < 44) issue(m.hitPx < 32 ? "major" : "minor", "round-board",
      `10-player pawn tap zone ${m.hitPx}px (visual ${m.pawnPx}px) is under the 44px guideline`);
    const { glowed } = await rollUntilGlow(pg, 30000);
    if (glowed) {
      const bb = await pg.evaluate(() => {
        const g = document.querySelector("#boardwrap [data-tok]");
        const r = g.getBoundingClientRect();
        return `${Math.round(r.width)}x${Math.round(r.height)}px`;
      });
      rec("10p glowing piece measured", true, `real [data-tok] bbox ${bb}`);
    }
    await audit(pg, "round-board");
    await shot(pg, "6-roundboard");
    await pg.tap("#leaveGameBtn").catch(() => {});
  } finally { await pg.close(); }
}

async function landscapeFlow(ctx) {
  const pg = await ctx.newPage();
  try {
    await pg.goto(BASE, { waitUntil: "networkidle", timeout: 90000 });
    await audit(pg, "landscape-home");
    await pg.fill("#nameIn", "Land");
    await pg.tap("#createBtn");
    await pg.waitForSelector("#lobby:not(.hidden)", { timeout: 15000 });
    await pg.tap("#addBotBtn");
    await pg.waitForFunction(() => document.getElementById("pcount").textContent.trim() === "2", null, { timeout: 8000 });
    await pg.tap("#startBtn");
    await pg.waitForSelector("#boardwrap svg", { timeout: 15000 });
    if (await pg.waitForSelector("#rollBtn:not(.hidden)", { timeout: 10000 }).catch(() => null)) await pg.tap("#rollBtn").catch(() => {});
    await pg.waitForTimeout(900);
    rec("landscape core flow", true, "create → bot → start → roll");
    await audit(pg, "landscape-midgame");
    await shot(pg, "7-landscape");
    await pg.tap("#leaveGameBtn").catch(() => {});
  } finally { await pg.close(); }
}

(async () => {
  const browsers = {
    // fake-media flags so Android/Chromium profiles have a mic; WebKit has mock devices built in
    chromium: await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] }),
    webkit: await webkit.launch(),
  };

  const only = process.env.ONLY ? process.env.ONLY.split(",") : null; // e.g. ONLY="iPhone SE" for a quick single-device run
  for (const dev of MATRIX) {
    if (only && !only.includes(dev.name)) continue;
    curDev = dev.name;
    console.log(`\n▶ ${dev.name} (${dev.engine}${dev.primary ? ", PRIMARY" : ""}) — ${JSON.stringify(devices[dev.name].viewport)}`);
    const ctx = await browsers[dev.engine].newContext({ ...devices[dev.name], reducedMotion: "reduce" });
    await ctx.grantPermissions(["microphone"], { origin: BASE });
    const pg = await ctx.newPage();
    pg.on("pageerror", (e) => { rec("page JS error", false, e.message.split("\n")[0]); issue("major", "runtime", "JS error: " + e.message.split("\n")[0]); });
    try { await fullFlow(pg); } catch (e) { rec("flow aborted", false, e.message.split("\n")[0]); }
    try { await roundBoardAudit(ctx); } catch (e) { rec("10p round board pawn size", false, e.message.split("\n")[0]); }
    if (dev.landscape) {
      curDev = dev.name + " (landscape)";
      const lctx = await browsers[dev.engine].newContext({ ...devices[dev.landscape], reducedMotion: "reduce" });
      try { await landscapeFlow(lctx); } catch (e) { rec("landscape core flow", false, e.message.split("\n")[0]); }
      await lctx.close();
    }
    await ctx.close();
  }

  /* ---- throttled pass: slow-4G + 4x CPU (CDP → Chromium engine, iPhone profiles) ---- */
  const throttled = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  for (const name of ["iPhone 17 Pro Max", "iPhone SE"].filter((n) => !only || only.includes(n))) {
    curDev = name + " (throttled)";
    console.log(`\n▶ ${curDev} — slow-4G + 4x CPU on Chromium (CDP throttling is Chromium-only)`);
    const ctx = await throttled.newContext({ ...devices[name], defaultBrowserType: undefined, reducedMotion: "reduce" });
    const pg = await ctx.newPage();
    const cdp = await ctx.newCDPSession(pg);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    try {
      const t0 = Date.now();
      await pg.goto(BASE, { waitUntil: "networkidle", timeout: 120000 });
      const tLoad = (Date.now() - t0) / 1000;
      await pg.fill("#nameIn", "Slow");
      await pg.tap("#createBtn");
      await pg.waitForSelector("#lobby:not(.hidden)", { timeout: 30000 });
      const tLobby = (Date.now() - t0) / 1000;
      timings.push({ device: name, load: tLoad, lobby: tLobby });
      rec("throttled: load → playable lobby", true, `page loaded ${tLoad.toFixed(1)}s, in lobby ${tLobby.toFixed(1)}s`);
    } catch (e) { rec("throttled: load → playable lobby", false, e.message.split("\n")[0]); }
    await ctx.close();
  }
  await throttled.close();
  for (const b of Object.values(browsers)) await b.close();

  fs.writeFileSync(SHOTS + "/mobile-results.json", JSON.stringify({ results, issues, timings, shotIndex }, null, 2));
  const fails = results.filter((r) => !r.ok);
  console.log(`\n════════ MOBILE MATRIX SUMMARY ════════`);
  console.log(`steps: ${results.length}, failed: ${fails.length}, issues: ${issues.filter(i => i.sev === "major" || i.severity === "major").length} major / ${issues.filter(i => i.severity === "minor").length} minor`);
  fails.forEach((f) => console.log(`  ✗ [${f.device}] ${f.step} — ${f.note}`));
  console.log(fails.length ? "\n=== RESULT: FAIL ===" : "\n=== RESULT: PASS ===");
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
