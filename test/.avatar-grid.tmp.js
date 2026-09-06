const { chromium } = require("playwright"); const OUT = process.argv[2];
const AV = ['🦊','🐼','🐸','🐯','🦁','🐨','🐙','🦉','🐺','🦄','👻','🤠','🐵','🐧','🦖','🐲'];
const NAMES = ['fox','panda','frog','tiger','lion','koala','octopus','owl','wolf','unicorn','ghost','cowboy','monkey','penguin','t-rex','dragon'];
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1200, height: 700 }, deviceScaleFactor: 2 });
  await p.setContent(`<style>body{margin:0;background:#141833;color:#c9cbe6;font:600 14px system-ui;padding:24px}h1{font:800 22px system-ui;color:#fff;margin:0 0 4px}p{margin:0 0 18px;color:#9aa0c8}.g{display:grid;grid-template-columns:repeat(8,1fr);gap:14px}.c{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:14px 8px;text-align:center}.e{font-size:72px;line-height:1}.n{margin-top:8px;text-transform:uppercase;letter-spacing:.08em;font-size:11px}.s{margin-top:18px;display:flex;gap:18px;align-items:center;color:#9aa0c8}.s span{display:inline-flex;align-items:center;gap:6px}</style>
  <h1>Current GameNest avatars — 16 system emoji</h1><p>What every player picks from today. Rendered by iOS, so they look different on Android and on the web, and they carry no GameNest style.</p>
  <div class="g">${AV.map((a,i)=>`<div class="c"><div class="e">${a}</div><div class="n">${String(i+1).padStart(2,'0')} ${NAMES[i]}</div></div>`).join('')}</div>
  <div class="s"><b>Sizes in use:</b><span><i style="font-size:48px">🦊</i>48 px picker</span><span><i style="font-size:26px">🦊</i>26 px profile row</span><span><i style="font-size:24px">🦊</i>24 px lobby list</span><span><i style="font-size:16px">🦊</i>16 px in-game chip</span></div>`);
  await p.screenshot({ path: OUT + "/01-current-emoji-set.png" }); await b.close(); console.log("grid ok");
})();
