# Ludo Rooms — test suites

Two suites, no framework — plain Node scripts that exit 0 on pass, 1 on fail.

## Setup (once)

```sh
cd test
npm install          # socket.io-client + playwright
npx playwright install chromium   # if you've never installed Playwright browsers
```

## 1. Rules-level suite — `e2e.js`

Drives real socket.io clients against a **local** server. Start the server with
fast bots (bots act in ~5ms instead of ~650ms) on a side port, then run:

```sh
# terminal 1, repo root (needs `npm install` in the root too):
BOT_DELAY_MS=5 PORT=3111 node server.js

# terminal 2:
node test/e2e.js                 # BASE=http://localhost:3111 by default
```

Covers: classic 2p game to completion (plus chat + bad-code regression checks),
addBot/removeBot and a bot playing itself to a win, team mode (3 humans +
auto-filled bot, no same-team captures, play continues after the first
finisher, winnerTeam sanity), and randomness of team draws across 12 games.

## 2. Browser suite — `ui-test.js`

Playwright (Chromium) against the **live** site. Creates throwaway rooms.

```sh
node test/ui-test.js             # BASE=https://needasix.com by default
BASE=http://localhost:3111 node test/ui-test.js   # or point it anywhere
```

Covers: lobby bot buttons + Teams toggle/notes, solo-vs-bot through the real
UI (board must advance on bot turns with no input), voice chat with two fake
mics (WebRTC must reach `connectionState "connected"`, mute must flip
`track.enabled`, leave must tear down), and a mobile pass on the iPhone 13
profile with an overflow/tap-target audit.

Screenshots land in `test/shots/` (override with `SHOTS=/path`).

Notes:
- Voice needs a secure context (https) — the default live URL provides that.
- Contexts use `reducedMotion: "reduce"`: the ROLL button's breathe animation
  moves its bounding box every frame, so clicks fail Playwright's stability
  check without it.
