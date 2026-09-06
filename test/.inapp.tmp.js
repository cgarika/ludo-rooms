/* Shared: make a live web client look like the bundled in-app client (same hide rules + one-line dock as the GameNest shim). */
const CSS = `html.in-app #lobby .wordmark, html.in-app #game .wordmark, html.in-app #leaveGameBtn, html.in-app #leaveLobbyBtn, html.in-app #game .rules, html.in-app #game .hint, html.in-app #game ~ .hint, html.in-app #rulesfoot, html.in-app body > .rules, html.in-app .themebtn, html.in-app .arcadelink{display:none!important} html.in-app #game{padding-top:2px}
html.in-app #game .voicebar{ display:flex; align-items:center; justify-content:center; gap:10px; flex-wrap:wrap; margin-top:10px; width:100% } html.in-app #game .voicebar.hidden{ display:flex !important }
html.in-app #voiceBtn{ font-size:0 !important; width:44px; height:44px; padding:0 !important; border-radius:50% !important; display:inline-flex; align-items:center; justify-content:center; flex:none } html.in-app #voiceBtn::before{ content:"🎙"; font-size:20px; line-height:1 }
html.in-app .voicebar .voicewho{ display:none } html.in-app .voicebar .chatcard{ display:contents }
html.in-app .voicebar .chattoggle{ width:auto; min-height:44px; padding:0 16px; border-radius:999px; font-size:14px; font-weight:800; color:inherit; background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.14); display:inline-flex; align-items:center; gap:8px }
html.in-app .voicebar #chatbody{ flex-basis:100%; width:100%; order:9 }`;
module.exports = async function applyInApp(page) {
  await page.evaluate((css) => {
    document.documentElement.classList.add("in-app"); const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
    const vb = document.querySelector("#game .voicebar"), cc = document.querySelector(".chatcard"), gm = document.getElementById("game");
    if (vb && cc && gm) { const vw = vb.querySelector(".voicewho"); if (vw) vb.appendChild(vw); const outside = !gm.contains(cc);
      const dock = () => { const inGame = !gm.classList.contains("hidden"); if (!outside || inGame) { if (cc.parentNode !== vb) vb.appendChild(cc); } else if (cc.parentNode === vb) gm.parentNode.insertBefore(cc, gm.nextSibling); };
      dock(); if (outside) new MutationObserver(dock).observe(gm, { attributes: true, attributeFilter: ["class"] }); }
  }, CSS);
};
