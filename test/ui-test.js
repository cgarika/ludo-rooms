/* Browser-level UI suite (Playwright) against the LIVE deployment.
   Run from test/:  node ui-test.js        (BASE=https://needasix.com by default)
   Screenshots land in $SHOTS or test/shots.

   Covers:
   5. Lobby UI: Add/Remove bot buttons, 🤖 + "(bot)" rows, Teams toggle ON/OFF + note
   6. Solo vs bot through the real UI: board advances on bot turns with no input
   7. Voice: two contexts with fake mics join voice, WebRTC reaches "connected",
      mute toggles track.enabled, leave tears down cleanly
   8. Mobile pass (iPhone 13 portrait): core flow + overflow/tap-target audit
*/
const { chromium, devices } = require("playwright");
const fs = require("fs");
const BASE = process.env.BASE || "https://needasix.com";
const SHOTS = process.env.SHOTS || __dirname + "/shots";
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
let cur = null;
const ok = (m) => console.log("  ✓", m);
const bad = (m) => { console.log("  ✗", m); cur.errors.push(m); process.exitCode = 1; };
const flag = (m) => { console.log("  ⚑", m); cur.flags.push(m); };

async function test(title, fn) {
  cur = { title, errors: [], flags: [] };
  console.log("\n▶ " + title);
  const t0 = Date.now();
  try { await fn(); } catch (e) { bad("EXCEPTION: " + e.message.split("\n")[0]); }
  cur.secs = ((Date.now() - t0) / 1000).toFixed(1);
  results.push(cur);
}

(async () => {
  const browser = await chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  });

  const mkPage = async (name, ctxOpts = {}, { mic = false } = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 900 }, reducedMotion: "reduce", ...ctxOpts });
    if (mic) await ctx.grantPermissions(["microphone"], { origin: BASE });
    const pg = await ctx.newPage();
    pg.on("pageerror", (e) => bad(`${name} JS error: ${e.message}`));
    pg._name = name;
    return pg;
  };
  const createRoom = async (pg, name) => {
    await pg.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });
    await pg.fill("#nameIn", name);
    await pg.click("#createBtn");
    await pg.waitForSelector("#lobby:not(.hidden)", { timeout: 10000 });
    return (await pg.textContent("#tiles")).trim().replace(/\s+/g, "");
  };
  const joinRoom = async (pg, name, code) => {
    await pg.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });
    await pg.fill("#nameIn", name);
    await pg.fill("#codeIn", code);
    await pg.click("#joinBtn");
    await pg.waitForSelector("#lobby:not(.hidden)", { timeout: 10000 });
  };
  const pcount = async (pg) => (await pg.textContent("#pcount")).trim();

  /* ---- 5 + 6 share one room: host page A ---- */
  const A = await mkPage("Alice");

  await test("5. Lobby UI: bot buttons, 🤖/(bot) rows, Teams toggle + note", async () => {
    const code = await createRoom(A, "Alice");
    ok(`room ${code} created`);

    await A.click("#addBotBtn");
    await A.waitForFunction(() => document.getElementById("pcount").textContent.trim() === "2", null, { timeout: 5000 });
    const row = await A.textContent("#plist");
    row.includes("(bot)") ? ok('bot row shows "(bot)" suffix') : bad('bot row missing "(bot)": ' + row.trim());
    row.includes("\u{1F916}") ? ok("bot row shows 🤖 avatar") : bad("bot row missing 🤖 avatar");

    await A.waitForSelector("#delBotBtn", { timeout: 3000 });
    await A.click("#delBotBtn");
    await A.waitForFunction(() => document.getElementById("pcount").textContent.trim() === "1", null, { timeout: 5000 });
    ok("Remove bot button removes the bot (back to 1 player)");
    (await A.$("#delBotBtn")) ? bad("Remove bot button still shown with no bots") : ok("Remove bot button hides when no bots remain");

    // teams toggle disabled until 4 seats
    let cls = await A.getAttribute("#teamrow .teambtn", "class");
    cls.includes("na") ? ok("Teams toggle disabled with <4 seats") : bad("Teams toggle enabled with <4 seats");
    (await A.textContent("#teamnote")).includes("needs 4 seats")
      ? ok("teams note explains 4 seats are needed") : bad("teams note wrong: " + await A.textContent("#teamnote"));

    for (let i = 0; i < 3; i++) { await A.click("#addBotBtn"); await A.waitForTimeout(250); }
    await A.waitForFunction(() => document.getElementById("pcount").textContent.trim() === "4", null, { timeout: 5000 });
    ok("added 3 bots → 4/10 seats");
    cls = await A.getAttribute("#teamrow .teambtn", "class");
    cls.includes("na") ? bad("Teams toggle still disabled at 4 seats") : ok("Teams toggle enabled at 4 seats");

    await A.click("#teamrow .teambtn");
    await A.waitForFunction(() => document.querySelector("#teamrow .teambtn").textContent.includes("ON"), null, { timeout: 5000 });
    ok("Teams toggle flips to ON");
    (await A.textContent("#teamnote")).includes("RANDOM")
      ? ok("teams note updates: random draw + both-partners-home rule") : bad("ON teams note wrong");
    await A.screenshot({ path: SHOTS + "/team-lobby.png" });

    await A.click("#teamrow .teambtn");
    await A.waitForFunction(() => document.querySelector("#teamrow .teambtn").textContent.includes("OFF"), null, { timeout: 5000 });
    ok("Teams toggle flips back to OFF");
    (await A.textContent("#teamnote")).includes("2v2")
      ? ok("OFF teams note invites 2v2 play") : bad("OFF teams note wrong: " + await A.textContent("#teamnote"));
  });

  await test("6. Solo vs bot through the real UI: board advances on bot turns", async () => {
    // trim the lobby down to Alice + one bot, teams off
    await A.click("#delBotBtn"); await A.waitForTimeout(300);
    await A.click("#delBotBtn"); await A.waitForTimeout(300);
    await A.waitForFunction(() => document.getElementById("pcount").textContent.trim() === "2", null, { timeout: 5000 });
    await A.click("#startBtn");
    await A.waitForSelector("#boardwrap svg", { timeout: 10000 });
    ok("started 1 human + 1 bot; board rendered");

    const botColor = await A.evaluate(() => S.room.players.find((p) => p.bot).color);
    let botAdvanced = false, boardChanged = false, botOut = false, myRolls = 0, shot = false;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const st = await A.evaluate(() => ({ status: S.room.status, turn: S.room.turn, mySeat: S.mySeat, v: S.room.v }));
      if (st.status !== "playing") break;
      if (st.turn === st.mySeat) {
        if (await A.$("#rollBtn:not(.hidden)")) { await A.click("#rollBtn").catch(() => {}); myRolls++; await A.waitForTimeout(700); }
        const tok = await A.$("#boardwrap [data-tok]");
        if (tok) { await tok.click().catch(() => {}); await A.waitForTimeout(400); }
      } else {
        // bot's turn — hands off, just watch
        const v0 = st.v;
        const board0 = await A.evaluate(() => document.getElementById("boardwrap").innerHTML.length + "|" + (document.getElementById("die").textContent || ""));
        await A.waitForTimeout(2600);
        const v1 = await A.evaluate(() => S.room.v);
        const board1 = await A.evaluate(() => document.getElementById("boardwrap").innerHTML.length + "|" + (document.getElementById("die").textContent || ""));
        if (v1 > v0) botAdvanced = true;
        if (board1 !== board0) boardChanged = true;
      }
      botOut = await A.evaluate((c) => S.room.tokens[c].some((t) => t !== -1), botColor);
      if (botOut && !shot) { await A.screenshot({ path: SHOTS + "/bot-midgame.png" }); shot = true; }
      await A.waitForTimeout(150);
    }
    if (!shot) await A.screenshot({ path: SHOTS + "/bot-midgame.png" });
    ok(`played ${myRolls} human rolls alongside the bot`);
    botAdvanced ? ok("game state advanced during bot turns with zero input") : bad("no state change during bot turns");
    boardChanged ? ok("board/die visibly changed during bot turns") : bad("board never changed during bot turns");
    botOut ? ok(`bot (${botColor}) brought tokens out of base on its own`) : flag("bot never rolled a 6 in the window (tokens still in base)");
    await A.click("#leaveGameBtn").catch(() => {});
    await A.waitForSelector("#home:not(.hidden)", { timeout: 5000 });
    ok("left the game back to home");
  });

  await test("7. Voice: 2 players connect, mute toggles track, leave tears down", async () => {
    const V1 = await mkPage("Vera", {}, { mic: true });
    const V2 = await mkPage("Wade", {}, { mic: true });
    const code = await createRoom(V1, "Vera");
    await joinRoom(V2, "Wade", code);
    await V1.click("#startBtn");
    await V1.waitForSelector("#voicebar:not(.hidden)", { timeout: 10000 });
    await V2.waitForSelector("#voicebar:not(.hidden)", { timeout: 10000 });
    ok("voice bar visible on both players once the game is live");

    await V1.click("#voiceBtn");
    await V1.waitForFunction(() => VOICE.on === true, null, { timeout: 8000 });
    await V2.click("#voiceBtn");
    for (const P of [V1, V2]) {
      await P.waitForFunction(() => document.getElementById("voicewho").textContent.includes("2 in voice"), null, { timeout: 15000 });
      ok(`${P._name}: bar shows "2 in voice"`);
    }
    for (const P of [V1, V2]) {
      await P.waitForFunction(
        () => VOICE.pcs.size >= 1 && [...VOICE.pcs.values()].every((pc) => pc.connectionState === "connected"),
        null, { timeout: 30000 }
      ).then(
        () => ok(`${P._name}: RTCPeerConnection reached connectionState "connected"`),
        async () => bad(`${P._name}: WebRTC never connected — states: ` +
          await P.evaluate(() => JSON.stringify([...VOICE.pcs.values()].map((pc) => pc.connectionState))))
      );
    }
    const pnl = await V1.$("#panel");
    await pnl.screenshot({ path: SHOTS + "/voice-connected.png" });

    // mute
    await V1.click("#voiceBtn"); // now toggles mute
    await V1.waitForFunction(() => VOICE.muted === true, null, { timeout: 5000 });
    (await V1.evaluate(() => VOICE.stream.getAudioTracks().every((t) => t.enabled === false)))
      ? ok("Mute disables the local audio track (track.enabled=false)") : bad("mute did not disable the track");
    (await V1.textContent("#voiceBtn")).includes("Unmute") ? ok('button relabels to "Unmute"') : bad("mute button label wrong");
    await V1.click("#voiceBtn");
    await V1.waitForFunction(() => VOICE.muted === false, null, { timeout: 5000 });
    (await V1.evaluate(() => VOICE.stream.getAudioTracks().every((t) => t.enabled === true)))
      ? ok("Unmute re-enables the track") : bad("unmute did not re-enable the track");

    // leave
    await V1.click("#voiceLeave");
    await V1.waitForFunction(() => !VOICE.on && VOICE.pcs.size === 0 && VOICE.stream === null, null, { timeout: 5000 });
    ok("leave voice: local peer map cleared, mic stream stopped");
    (await V1.textContent("#voiceBtn")).includes("Join voice") ? ok('button back to "Join voice"') : bad("leave label wrong");
    await V2.waitForFunction(() => document.getElementById("voicewho").textContent.includes("1 in voice"), null, { timeout: 8000 });
    await V2.waitForFunction(() => VOICE.pcs.size === 0, null, { timeout: 8000 });
    ok('other player sees "1 in voice" and drops the dead peer connection');

    await V2.click("#voiceLeave").catch(() => {});
    for (const P of [V1, V2]) await P.click("#leaveGameBtn").catch(() => {});
    await V1.context().close(); await V2.context().close();
  });

  await test("8. Mobile pass: iPhone 13 portrait, core flow + overflow audit", async () => {
    const iphone = devices["iPhone 13"];
    const ctx = await browser.newContext({ ...iphone, reducedMotion: "reduce" });
    const M = await ctx.newPage();
    M.on("pageerror", (e) => bad(`mobile JS error: ${e.message}`));

    const audit = async (stage) => {
      const issues = await M.evaluate(() => {
        const out = [];
        const W = window.innerWidth, de = document.documentElement;
        if (de.scrollWidth > W + 1) out.push(`page overflows horizontally: ${de.scrollWidth}px > ${W}px viewport`);
        const sels = "button, input, [data-tok], .avchip, .schip, .tokbtn, .chattoggle, .sendbtn, #voiceLeave";
        for (const el of document.querySelectorAll(sels)) {
          if (el.classList.contains("hidden") || (!(el instanceof SVGElement) && el.offsetParent === null)) continue;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          const name = `<${el.tagName.toLowerCase()}${el.id ? "#" + el.id : "." + ((el.getAttribute("class") || "").split(" ")[0] || "")}>`;
          if (r.width < 24 || r.height < 24) out.push(`tap target under 24px: ${name} ${Math.round(r.width)}x${Math.round(r.height)}`);
          if (r.left < -1 || r.right > W + 1) {
            let scrollable = false;
            for (let a = el.parentElement; a; a = a.parentElement) {
              const cs = getComputedStyle(a);
              if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && a.scrollWidth > a.clientWidth + 1) { scrollable = true; break; }
            }
            if (!scrollable) out.push(`control clipped horizontally: ${name} ${Math.round(r.left)}..${Math.round(r.right)} (viewport ${W})`);
          }
          el.scrollIntoView({ block: "center" });
          const r2 = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r2.x + r2.width / 2, r2.y + r2.height / 2);
          if (hit && !el.contains(hit) && !hit.contains(el))
            out.push(`unreachable — covered by <${hit.tagName.toLowerCase()}${hit.id ? "#" + hit.id : ""}>: ${name}`);
        }
        window.scrollTo(0, 0);
        return out;
      });
      issues.length ? issues.forEach((i) => flag(`[${stage}] ${i}`)) : ok(`[${stage}] no overflow, controls ≥24px and reachable`);
    };

    await M.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });
    await audit("home");
    await M.fill("#nameIn", "Mia");
    await M.tap("#createBtn");
    await M.waitForSelector("#lobby:not(.hidden)", { timeout: 10000 });
    await M.tap("#addBotBtn");
    await M.waitForFunction(() => document.getElementById("pcount").textContent.trim() === "2", null, { timeout: 5000 });
    ok("create + Add a bot by touch");
    await audit("lobby");
    await M.tap("#startBtn");
    await M.waitForSelector("#boardwrap svg", { timeout: 10000 });
    ok("start by touch → board rendered");
    let rolls = 0, taps = 0;
    for (let i = 0; i < 12; i++) {
      if (await M.$("#rollBtn:not(.hidden)")) { await M.tap("#rollBtn").catch(() => {}); rolls++; await M.waitForTimeout(700); }
      const tok = await M.$("#boardwrap [data-tok]");
      if (tok) { await tok.tap().catch(() => {}); taps++; await M.waitForTimeout(400); }
      await M.waitForTimeout(300);
    }
    rolls >= 2 ? ok(`gameplay by touch works (${rolls} die taps, ${taps} piece taps)`) : bad("die taps not registering on touch");
    await audit("mid-game");
    await M.screenshot({ path: SHOTS + "/mobile-midgame.png" });
    await M.tap("#leaveGameBtn").catch(() => {});
    await ctx.close();
  });

  await browser.close();
  console.log("\n════════ UI SUITE SUMMARY ════════");
  for (const r of results)
    console.log(` ${r.errors.length ? "FAIL" : "PASS"}${r.flags.length ? "⚑" : ""}  ${r.title}  (${r.secs}s)` +
      (r.errors.length ? "\n        " + r.errors.join("\n        ") : "") +
      (r.flags.length ? "\n        flags: " + r.flags.join("; ") : ""));
  const failed = results.filter((r) => r.errors.length).length;
  console.log(failed ? `\n=== RESULT: FAIL (${failed} of ${results.length}) ===` : "\n=== RESULT: PASS ===");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
