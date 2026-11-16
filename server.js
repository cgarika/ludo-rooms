/* Ludo Rooms - self-hosted server (deluxe)
   Serves the game page and runs every room over WebSockets.
   The server owns the rules: it rolls the dice, checks every move,
   validates chat + stickers, and reports each move so clients can
   animate it. Rooms hold 2-10 players. */

const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");
const Reactions = require("./reactions");   // the cartoon stickers (2026-10-15)
const Quick = require("./quickmatch");   // quick play and ranked (2026-10-24)
const Plus = require("./plus");   // GameNest Plus: the room's flag and each player's look (2026-10-16)
const Moderation = require("./moderation");   // what players type, kept friendly (2026-10-18)
const Power = require("./power").make(["shield", "step", "reroll"]);   // Power mode: the one-use power-ups (2026-11-13)

const app = express();
const server = http.createServer(app);
const BASE = (process.env.BASE_PATH || "").replace(/\/$/, "");
const io = new Server(server, { path: BASE + "/socket.io" });
/* Every client event goes through one guard (as in Nightfall and Word Spies, less their flood limit). A payload that
   is not an object (null, a number, a string, an array) arrives as {}: 42["join",null] used to throw inside the
   handler's destructuring and stop the whole process, every room with it. A handler that still throws is logged and
   the server carries on. */
function guarded(socket) {
  return (event, fn) => socket.on(event, (payload, ...rest) => {
    try { fn(payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {}, ...rest); }
    catch (e) { console.error(`[${new Date().toISOString()}] ${event} failed:`, (e && e.stack) || e); }
  });
}
if (BASE) app.use((req, res, next) => { if (req.path === BASE) return res.redirect(301, BASE + "/"); next(); });
app.use(BASE || "/", express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const ROOM_IDLE_MS = 2 * 3600e3;
const MAX_PLAYERS = 10;
const CHAT_KEEP = 60;
const CHAT_COOLDOWN_MS = 800;
const TURN_MS = Math.max(500, Number(process.env.TURN_MS || 60000));        // normal turn timer (45 s at 6+ players)
const TURN_MS_BIG = Math.max(500, Number(process.env.TURN_MS_BIG || Math.min(45000, TURN_MS)));
const AFK_MS = Math.max(200, Number(process.env.AFK_MS || 5000));            // turn timer while the player is disconnected
const TIMEOUTS_TO_BOT = 3;                                                     // consecutive timeouts before a bot takes the seat
const POWER_HOLD_MS = Math.max(50, Number(process.env.POWER_HOLD_MS || 4000));  // Power mode: how long a dead roll waits for the re-roll key

const ORDER = ["red","green","yellow","blue","orange","purple","teal","pink","lime","brown"];
const ASSIGN = ["red","yellow","green","blue","orange","purple","teal","pink","lime","brown"];
const STICKERS = ["lol","cry","fire","dice","snail","devil","pray","skull","party","angry","pinch","run"];
// v1's twelve, then GameNest 2.0's twenty sticker avatars (the app's Content/Data/games.json "avatars"): an avatar outside this
// list reached the other players as a plain smiley, so in Ludo 15 of the app's 20 stickers showed as 🙂 to everyone else (2026-11-16).
const AVATARS = ["\u{1F60E}","\u{1F913}","\u{1F451}","\u{1F42F}","\u{1F43C}","\u{1F98A}","\u{1F47D}","\u{1F916}","\u{1F355}","\u{1F438}","\u{1F984}","\u{1F4A9}",
  "\u{1F419}","\u{1F981}","\u{1F47B}","\u{1F427}","\u{1F424}","\u{1F432}","\u{1F435}","\u{1F996}","\u{1F428}","\u{1F980}","\u{1F989}","\u{1F98E}","\u{1F988}","\u{1F41D}","\u{1F335}"];

const rooms = new Map();
app.get("/internal/roster/:code", Plus.rosterHandler((code) => rooms.get(code)));   // who is at a table, for the wallet's Treat the room (404 without GN_INTERNAL_SECRET)
/* GameNest Plus: a player says on create and join that they own Plus; a room
   whose host owns it is a Plus room, and every client shows its extras.
   The client's word is taken for now (checking Apple's receipt is a later step). */
function stampPlus(code, socket, said) {
  const room = rooms.get(code);
  const p = room && socket && socket.data && room.players.find((q) => q.id === socket.data.playerId);
  if (p) { Plus.stampFor(p, said, socket); Plus.dedupe(room, p); }
}
const timers = new Map();
const roomSockets = new Map();

const CODE_ALPHABET = "ABCDEFGHJKMNPRTWXYZ";   // six letters, never a digit, none of I L O Q S U V (2026-11-13)
function genCode() {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return s;
}
const newId = () => crypto.randomBytes(8).toString("hex");
const cleanName = (n) => { const c = String(n || "").replace(/[<>&"'`]/g, "").trim().slice(0, 14); return c ? Moderation.name(c) : c; };   // a bad name is "Player"
const cleanChat = (n) => String(n || "").replace(/[<>&"'`]/g, "").trim().slice(0, 140);
const cleanAvatar = (a) => (AVATARS.includes(a) ? a : "\u{1F642}");

/* Positions per token: -1 base, 0..M-2 shared track, M-1..M+3 home lane,
   M+4 finished. Classic board is M=52 (track 0..50, lane 51..55, done 56). */
/* GameNest Plus's boards (2026-10-17): the host's pick, the classic one for every room and the other three for a
   Plus room; the state carries the board in use (classic again if no one in the room owns Plus). */
const BOARDS = Object.freeze(["classic", "candy", "palace", "galaxy"]);

function buildConfig(sortedColors, tokensPer) {
  const n = sortedColors.length;
  if (n <= 4) {
    const classic = { red: 0, green: 13, yellow: 26, blue: 39 };
    const starts = {};
    sortedColors.forEach((c) => { starts[c] = classic[c]; });
    return {
      mode: "cross", M: 52, tpp: tokensPer, starts,
      safe: [0, 8, 13, 21, 26, 34, 39, 47],
    };
  }
  const seg = 8;
  const M = seg * n;
  const starts = {};
  const safe = [];
  sortedColors.forEach((c, k) => {
    starts[c] = k * seg;
    safe.push(k * seg, k * seg + 4);
  });
  return { mode: "circle", M, tpp: tokensPer, starts, safe, seg };
}

function legalMoves(room) {
  const color = room.players[room.turn].color;
  const die = room.die;
  const out = [];
  if (die == null) return out;
  const finish = room.cfg.M + 4;
  if (stepping(room)) return stepMoves(room);   // Power mode's extra step: the roll plus one, and only for a pawn that is out
  room.tokens[color].forEach((p, i) => {
    if (p === finish) return;
    if (p === -1) {
      if (die === 6) out.push(i);
    } else if (p + die <= finish) {
      out.push(i);
    }
  });
  return out;
}
/* Power mode's extra step. It is on from the tap until the move is made; the pawns it can move are the ones out of the
   yard that have room for the roll plus one (it never brings a pawn out of the yard). */
const stepping = (room) => !!(room.pw && room.pw.step);
function stepMoves(room) {
  const out = [];
  if (room.die == null) return out;
  const finish = room.cfg.M + 4;
  room.tokens[room.players[room.turn].color].forEach((p, i) => { if (p >= 0 && p !== finish && p + room.die + 1 <= finish) out.push(i); });
  return out;
}

function passTurn(room) {
  if (room.pw) { room.pw.step = false; room.pw.hold = null; room.pw.turnUsed = false; }   // Power mode: one power-up a turn, and the turn is over
  room.die = null;
  room.phase = "roll";
  room.sixes = 0;
  const finish = room.cfg.M + 4;
  const n = room.players.length;
  for (let k = 1; k <= n; k++) {
    const j = (room.turn + k) % n;
    const pl = room.players[j];
    if (!pl.left && !room.tokens[pl.color].every((p) => p === finish)) {
      room.turn = j;
      return;
    }
  }
}

function clearTimer(code) {
  const t = timers.get(code);
  if (t) { clearTimeout(t); timers.delete(code); }
}

function armTimer(code) {
  clearTimer(code);
  scheduleBot(code);
  const room = rooms.get(code);
  if (!room || room.status !== "playing") {
    if (room) room.turnEndsAt = null;
    return;
  }
  if (room.pw && room.pw.hold) {   // Power mode: a dead roll held for the re-roll key; the pass waits for it, and no timeout is counted
    room.turnEndsAt = room.pw.hold;
    timers.set(code, setTimeout(() => endHold(code), Math.max(0, room.pw.hold - Date.now())));
    return;
  }
  const cur = room.players[room.turn];
  const ms = cur && !cur.bot && !cur.botControlled && !cur.connected ? AFK_MS : room.players.length >= 6 ? TURN_MS_BIG : TURN_MS;
  room.turnEndsAt = Date.now() + ms;
  timers.set(code, setTimeout(() => onTurnTimeout(code), ms));
}

/* T1 AFK policy: a timed-out turn is auto-played with the bot heuristic instead of skipped;
   three consecutive timeouts hand the seat to the bot until the human acts or reconnects. */
function onTurnTimeout(code) {
  const r = rooms.get(code);
  if (!r || r.status !== "playing") return;
  const pl = r.players[r.turn];
  if (!pl) return;
  let note = "";
  if (!pl.bot && !pl.botControlled) {
    pl.timeouts = (pl.timeouts || 0) + 1;
    if (pl.timeouts >= TIMEOUTS_TO_BOT) {
      pl.botControlled = true;
      note = `A bot is playing for ${pl.name} (timed out ${TIMEOUTS_TO_BOT} times).`;
    } else {
      note = `${pl.name} ran out of time; the turn was played for them.`;
    }
  }
  autoPlayTurn(r);
  if (note && rooms.get(code) === r) {   // keep the note visible ahead of whatever the auto-played turn logged
    r.log = `${note} ${r.log}`;
    r.v++;
    sendState(code);
  }
}

/* Plays the current seat's whole turn (roll, move, and any extra rolls from sixes) with the bot heuristic. */
function autoPlayTurn(r) {
  const seat = r.turn;
  for (let guard = 0; guard < 6 && r.status === "playing" && r.turn === seat; guard++) {
    if (r.phase === "roll") { performRoll(r, { auto: true }); continue; }   // auto: an auto-played turn never waits for (or spends) a power-up
    const lm = legalMoves(r);
    if (lm.length) performMove(r, botPick(r, lm));
    else { passTurn(r); r.v++; r.touched = Date.now(); sendState(r.code); armTimer(r.code); }
  }
  if (r.status === "playing" && r.turn === seat) armTimer(r.code);   // still their turn (very rare): keep the clock running
}

/* The human acts (or reconnects): take the seat back from the bot and reset the timeout streak. */
function humanIsBack(room, p, reason) {
  const wasBot = !!p.botControlled;
  p.timeouts = 0;
  if (!wasBot) return false;
  p.botControlled = false;
  room.log = `${p.name} is back at the table${reason ? " (" + reason + ")" : ""}.`;
  room.v++;
  if (room.status === "playing" && room.players[room.turn] === p) { clearBotTimer(room.code); armTimer(room.code); }
  return true;
}

function publicRoom(room) {
  return {
    code: room.code,
    status: room.status,
    players: room.players.map((p) => ({
      name: p.name, color: p.color, left: p.left, connected: p.connected, avatar: p.avatar, ...Plus.seat(p), bot: !!p.bot, botControlled: !!p.botControlled,
    })),
    hostSeat: room.players.findIndex((p) => p.id === room.host),
    turn: room.turn,
    phase: room.phase,
    die: room.die,
    tokens: room.tokens,
    winner: room.winner,
    winnerTeam: room.winnerTeam || null,
    teamMode: !!room.teamMode,
    teamChoice: !!room.teamChoice,
    teamOf: room.teamOf || null,
    voice: room.voice ? Array.from(room.voice) : [],
    log: room.log,
    turnEndsAt: room.turnEndsAt,
    tokenChoice: room.tokenChoice,
    cfg: room.cfg,
    chat: room.chat,
    lastMove: room.lastMove,
    v: room.v,
    ...Reactions.view(room),   // 2026-10-15: reactionsOn and the last reactions (after every old field)
    ...Quick.view(room),   // quick play and ranked (2026-10-24)
    board: Plus.gate(room, room.board || "classic", "classic"),   // GameNest Plus's boards (2026-10-17), after them
    ...powerView(room),   // Power mode (2026-11-13): mode always, power in a Power room; after every older field
  };
}


/* ---------- GameNest push (optional; no-op without PUSH_URL) ----------

   The app registers a device token per socket and reports presence; players who are away or disconnected

   get a push when it becomes their turn / a new phase starts, and when someone writes in chat. */

const PUSH_URL = process.env.PUSH_URL || "";

const PUSH_TITLE = 'Ludo';

function pushTo(p, body, data, collapse) {

  if (!PUSH_URL || !p || !p.pushToken || p.bot || p.left) return;

  if (!(p.away || !p.connected)) return;

  const now = Date.now(); if (p._lastPush && now - p._lastPush < 4000) return; p._lastPush = now;

  fetch(PUSH_URL + "/notify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: p.pushToken, title: PUSH_TITLE, body, data: data || {}, collapse: collapse || undefined }) }).catch(() => {});

}

function pushTurn(room) {   // called after every state broadcast; only fires when the situation changes

  const key = room.status + "|" + room.turn;

  if (room._pushKey === key) return; room._pushKey = key;

  if (room.status !== "playing") return;

  const p = room.players[room.turn]; if (!p) return;

  pushTo(p, "Your turn in " + PUSH_TITLE + " — room " + room.code, { code: room.code, game: PUSH_TITLE }, room.code + "-turn");

}


/* ---------- the waiting line (the owner, 2026-09-29) ----------
   Someone who joins a game already under way (and whose app says "waitList") waits in line,
   watching. A seat someone leaves mid-game goes to the first in line at once, keeping its colour
   and its pieces where they stand; the rest are seated at the next game, bots making room. */
function takeLeftSeats(room) {
  if (!room.waiting || !room.waiting.length || room.status !== "playing") return false;
  let seated = false;
  for (let seat = 0; seat < room.players.length && room.waiting.length; seat++) {
    const old = room.players[seat];
    if (!old.left) continue;
    const w = room.waiting.shift();
    room.players[seat] = Object.assign({}, old, { id: w.id, name: w.name, avatar: w.avatar, bot: false, botControlled: false,
      left: false, connected: true, plus: w.plus, acct: w.acct, look: w.look, timeouts: 0, pw: w.pw || Power.seat(null, null) });
    room.log = `${w.name} took ${old.name}'s seat.`;
    seated = true;
  }
  return seated;
}
function seatTheLine(room) {
  while (room.waiting && room.waiting.length) {
    if (room.players.length >= MAX_PLAYERS) {
      const bot = room.players.findIndex((p) => p.bot);
      if (bot < 0) break;
      room.players.splice(bot, 1);
    }
    const w = room.waiting.shift();
    const taken = room.players.map((q) => q.color);
    room.players.push({ id: w.id, name: w.name, color: ASSIGN.find((c) => !taken.includes(c)), left: false, connected: true, avatar: w.avatar, plus: w.plus, acct: w.acct, look: w.look, pw: w.pw || Power.seat(null, null) });
  }
}
function lineState(room, st, playerId, seat) {
  st.waiting = (room.waiting || []).map((w) => ({ name: w.name, avatar: w.avatar }));
  st.waitPos = seat < 0 ? (room.waiting || []).findIndex((w) => w.id === playerId) + 1 : 0;
  return st;
}

/* A reaction landed after the move it answers: everyone's state again. */
function reactBump(room) { room.v++; room.touched = Date.now(); sendState(room.code); }

function sendState(code) {
  const room = rooms.get(code);
  const sockets = roomSockets.get(code);
  if (!room || !sockets) return;
  const pub = publicRoom(room);
  for (const s of sockets) {
    const mySeat = room.players.findIndex((p) => p.id === s.data.playerId);
    const st = lineState(room, Object.assign({}, pub), s.data.playerId, mySeat);
    if (pub.power && mySeat >= 0) { const mine = powerMe(room, mySeat); if (mine) st.power = Object.assign({}, pub.power, { me: mine }); }   // their own stock, to them alone
    s.emit("state", { room: st, mySeat });
    try { pushTurn(room); } catch (_) {}
  }
}

function attach(socket, code) {
  socket.data.roomCode = code;
  if (!roomSockets.has(code)) roomSockets.set(code, new Set());
  roomSockets.get(code).add(socket);
}

function detach(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const set = roomSockets.get(code);
  if (set) { set.delete(socket); if (set.size === 0) roomSockets.delete(code); }
  socket.data.roomCode = null;
}

function deleteRoom(code) {
  clearTimer(code);
  clearBotTimer(code);
  rooms.delete(code);
}

/* GN-19: the cross board (four seats or fewer) has a start only for the classic four colours (buildConfig). Colours
   are handed out in join order, so a lobby where one of the first four left, or a rematch after a five-seat game lost
   a player, can reach the cross board holding orange or purple, a colour with no start and no pieces. Such a seat
   takes a free classic colour (in the order colours are handed out), and the log says so. */
const CLASSIC4 = ["red", "green", "yellow", "blue"];
function classicColours(room) {
  if (room.players.length > 4) return "";
  const free = ASSIGN.filter((c) => CLASSIC4.includes(c) && !room.players.some((p) => p.color === c));
  const moved = [];
  for (const p of room.players) if (!CLASSIC4.includes(p.color)) { p.color = free.shift(); moved.push(`${p.name} plays ${p.color}`); }
  return moved.length ? `${moved.join(", ")} on the four-colour board.` : "";
}

function setupGame(room) {
  room.players = room.players.filter((p) => !p.left);
  seatTheLine(room);
  room.recolourNote = classicColours(room);
  room.players.sort((a, b) => ORDER.indexOf(a.color) - ORDER.indexOf(b.color));
  const colors = room.players.map((p) => p.color);
  room.cfg = buildConfig(colors, room.tokenChoice || 4);
  room.tokens = Object.fromEntries(
    colors.map((c) => [c, Array(room.cfg.tpp).fill(-1)])
  );
  room.status = "playing";
  room.turn = 0; room.phase = "roll"; room.die = null; room.sixes = 0; room.winner = null;
  room.winnerTeam = null;
  room.teamMode = !!(room.teamChoice && room.players.length === 4 && room.players.every((p) => !p.left));
  room.teamOf = null;
  if (room.teamMode) {
    const mate = 1 + crypto.randomInt(3);
    const teamOf = [0, 1, 1, 1];
    teamOf[mate] = 0;
    room.teamOf = teamOf;
  }
  room.lastMove = null;
  setupPower(room);
}

/* ---------- Power mode (2026-11-13; power.js has the rules that never bend) ----------
   Shield: on your turn, before your pawn moves, one of your pawns on the track wears it until it blocks one capture (the
   attacker lands and both share the square). One shielded pawn at a time for a player; a pawn that leaves the shared track
   (into its home lane, or home) keeps nothing. Extra step: after the roll, the move is the roll plus one for a pawn that is
   out of the yard; "a six rolls again" looks at the die only. Re-roll: after the roll, the roll is thrown away (its six with
   it) and rolled again; a roll with no move waits up to POWER_HOLD_MS for a player who could still save it. */
const POWER_NAMES = { shield: "a Shield", step: "an Extra step", reroll: "a Re-roll" };

function setupPower(room) {
  if (room.mode !== "power") { room.pw = null; return; }
  const seq = (room.pw && room.pw.seq) || 0;   // the uses' ids keep counting through a rematch
  room.pw = { game: crypto.randomBytes(4).toString("hex"), seq, last: null, hold: null, step: false, turnUsed: false, sixesBefore: 0,
    shield: Object.fromEntries(room.players.map((p) => [p.color, -1])) };
  const uses = Power.botUses(room.players.filter((p) => !p.bot).map((p) => p.pw));
  for (const p of room.players) {
    if (!p.pw) p.pw = Power.seat(null, null);
    Power.fresh(p.pw);
    if (p.bot) Power.bot(p.pw, uses);
  }
}

/* What the seat could use right now, by the rules alone (its turn, a use left, none used this turn, the phase); whether it
   owns one is the stock's business. shield lists the pawns that can take it. */
function powerCan(room, seat) {
  const can = { shield: [], step: false, reroll: false };
  const p = room.players[seat];
  if (room.status !== "playing" || !room.pw || room.turn !== seat || !p || !p.pw || p.pw.left <= 0 || room.pw.turnUsed) return can;
  const trackEnd = room.cfg.M - 2;
  if (!room.pw.hold && room.pw.shield[p.color] < 0) room.tokens[p.color].forEach((t, i) => { if (t >= 0 && t <= trackEnd) can.shield.push(i); });
  if (room.phase === "move" && room.die != null && !room.pw.step) {
    can.step = stepMoves(room).length > 0;
    can.reroll = true;
  }
  return can;
}

function powerView(room) {
  const mode = room.mode === "power" ? "power" : "classic";
  if (mode !== "power") return { mode };
  const pw = room.status === "lobby" ? null : room.pw;
  return { mode, power: {
    game: pw ? pw.game : null,
    max: Power.MAX_USES,
    seats: room.players.map((p) => ({ used: pw ? Power.used(p.pw) : 0, shield: pw && pw.shield[p.color] !== undefined ? pw.shield[p.color] : -1 })),
    step: !!(pw && pw.step),
    hold: pw ? pw.hold : null,
    last: pw ? pw.last : null,
  } };
}
function powerMe(room, seat) {
  const p = room.players[seat];
  if (!p || !p.pw) return null;
  return Object.assign(Power.me(p.pw), { can: powerCan(room, seat) });
}

/* A dead roll is held when the player whose roll it is owns a re-roll they may still use (the extra step never saves a dead
   roll: one more square never makes an overshoot fit, and it never leaves the yard). Never for a seat nobody is at (away, or
   played by a bot for a timed-out person). */
function holdFor(room) {
  const pl = room.players[room.turn], pw = pl && pl.pw;
  if (!room.pw || !pw || pw.left <= 0 || room.pw.turnUsed) return false;
  if (!pl.bot && (pl.botControlled || !pl.connected)) return false;
  return pw.stock.reroll > 0;
}
function endHold(code) {
  const r = rooms.get(code);
  if (!r || r.status !== "playing" || !r.pw || !r.pw.hold) return;
  passTurn(r);
  r.v++;
  r.touched = Date.now();
  sendState(code);
  armTimer(code);
}

/* One power-up, for the seat whose turn it is (a pawn index for the shield, when more than one can take it). It is spent
   the moment it is used. Returns nothing when it was used, or the words for why it was not. */
function usePower(room, kind, i) {
  if (room.mode !== "power" || !room.pw || room.status !== "playing") return "Power-ups are for Power rooms.";
  const seat = room.turn, pl = room.players[seat], pw = pl && pl.pw;
  if (!pw || !Power.kinds.includes(kind)) return "No such power-up.";
  if (pw.left <= 0) return "No uses left this game.";
  if (room.pw.turnUsed) return "One power-up a turn.";
  if (pw.stock[kind] <= 0) return "You have none of those.";
  const can = powerCan(room, seat);
  let pawn = -1;
  if (kind === "shield") {
    if (!can.shield.length) return room.pw.shield[pl.color] >= 0 ? "One shielded pawn at a time." : room.pw.hold ? "No move to shield." : "No pawn on the track to shield.";
    pawn = Number.isInteger(i) ? i : can.shield.length === 1 ? can.shield[0] : -1;
    if (!can.shield.includes(pawn)) return "Pick a pawn on the track.";
  } else if (kind === "step") {
    if (!can.step) return room.phase !== "move" ? "Roll first." : "No pawn can move one more.";
  } else if (!can.reroll) {
    return "Roll first.";
  }
  Power.spend(pw, kind);
  room.pw.turnUsed = true;
  room.pw.hold = null;
  room.pw.last = Object.assign({ id: ++room.pw.seq, seat, kind }, pawn >= 0 ? { i: pawn } : {});
  room.log = `${pl.name} used ${POWER_NAMES[kind]}.`;
  for (const s of roomSockets.get(room.code) || []) s.emit("powerUsed", room.pw.last);   // the one broadcast; the state carries it too (power.last) for whoever was away
  if (kind === "reroll") {   // the roll is thrown away, and its six with it
    room.sixes = room.pw.sixesBefore;
    performRoll(room, { reroll: true });
    return null;
  }
  if (kind === "shield") room.pw.shield[pl.color] = pawn;
  if (kind === "step") room.pw.step = true;
  room.v++;
  room.touched = Date.now();
  sendState(room.code);
  if (pl.bot) scheduleBot(room.code);   // its roll or its move follows
  return null;
}

/* How many enemy pawns stand 1 to 6 cells behind this cell of the shared track (none count on a safe cell). */
function threatsAt(room, color, abs) {
  const cfg = room.cfg, trackEnd = cfg.M - 2;
  if (cfg.safe.includes(abs)) return 0;
  let n = 0;
  for (const c of enemyColorsOf(room, color)) for (const p of room.tokens[c]) {
    if (p < 0 || p > trackEnd) continue;
    const d = (abs - ((cfg.starts[c] + p) % cfg.M) + cfg.M) % cfg.M;
    if (d >= 1 && d <= 6) n++;
  }
  return n;
}

/* A bot's power-up, by plain sense: the re-roll that saves a dead roll, the extra step that captures or brings a pawn home
   when the roll alone does neither, the shield for the pawn an enemy can reach once this move is made.
   True when it used one: that is the bot's action for now, and its roll or move follows. */
function botPower(r) {
  const pl = r.players[r.turn];
  if (!r.pw || !pl || !pl.bot || !pl.pw || pl.pw.left <= 0 || r.pw.turnUsed || r.phase !== "move" || r.die == null) return false;
  const can = powerCan(r, r.turn), own = pl.pw.stock;
  const lm = legalMoves(r);
  if (!lm.length) return can.reroll && own.reroll > 0 ? !usePower(r, "reroll") : false;   // a dead roll, held for this
  const plain = botDecide(r, lm);
  if (can.step && own.step > 0 && plain.why !== "capture" && plain.why !== "finish") {
    let better = false;
    r.pw.step = true;
    try { const sm = legalMoves(r); if (sm.length) { const why = botDecide(r, sm).why; better = why === "capture" || why === "finish"; } } finally { r.pw.step = false; }
    if (better) return !usePower(r, "step");
  }
  if (can.shield.length && own.shield > 0) {
    const cfg = r.cfg, trackEnd = cfg.M - 2, toks = r.tokens[pl.color];
    const after = (i) => (i !== plain.i ? toks[i] : toks[i] === -1 ? 0 : toks[i] + r.die);   // where the pawn stands once the move is made
    const risky = can.shield.filter((i) => { const p = after(i); return p >= 6 && p <= trackEnd && threatsAt(r, pl.color, (cfg.starts[pl.color] + p) % cfg.M) > 0; });
    if (risky.length) return !usePower(r, "shield", risky.reduce((a, b) => (after(a) >= after(b) ? a : b)));
  }
  return false;
}

function performMove(room, i) {
    const pl = room.players[room.turn];
    const lm = legalMoves(room);
    if (!lm.includes(i)) return;
    const cfg = room.cfg;
    const finish = cfg.M + 4;
    const trackEnd = cfg.M - 2;
    const safeSet = new Set(cfg.safe);
    const color = pl.color;
    const die = room.die;
    const toks = room.tokens[color];
    const from = toks[i];
    const step = stepping(room) ? 1 : 0;   // Power mode's extra step (legalMoves has already left the yard out)
    const to = from === -1 ? 0 : from + die + step;
    toks[i] = to;
    if (room.pw) room.pw.step = false;
    const blocked = [];

    let capturedNames = [];
    let capturedList = [];
    if (to >= 0 && to <= trackEnd) {
      const abs = (cfg.starts[color] + to) % cfg.M;
      if (!safeSet.has(abs)) {
        for (const c of Object.keys(room.tokens)) {
          if (c === color) continue;
          if (room.teamMode) {
            const vSeat = room.players.findIndex((q) => q.color === c);
            if (vSeat >= 0 && room.teamOf && room.teamOf[vSeat] === room.teamOf[room.turn]) continue;
          }
          room.tokens[c] = room.tokens[c].map((p, idx) => {
            if (p >= 0 && p <= trackEnd && (cfg.starts[c] + p) % cfg.M === abs) {
              if (room.pw && room.pw.shield[c] === idx) { room.pw.shield[c] = -1; blocked.push({ c, i: idx }); return p; }   // the shield blocks this one capture and pops; both pawns share the square
              const owner = room.players.find((q) => q.color === c);
              if (owner && !capturedNames.includes(owner.name)) capturedNames.push(owner.name);
              capturedList.push({ c, i: idx, from: p });
              return -1;
            }
            return p;
          });
        }
      }
    }

    const gotHome = to === finish;
    room.v++;
    room.lastMove = { color, i, from, to, captured: capturedList, mv: room.v };
    if (room.pw) {
      if (blocked.length) room.lastMove.blocked = blocked;
      if (step) room.lastMove.step = true;
      if (room.pw.shield[color] === i && to > trackEnd) room.pw.shield[color] = -1;   // off the shared track nothing can capture it: the shield is gone
    }
    // The bots' reactions (2026-10-15): a capture made and suffered, and the win (below).
    if (capturedList.length) {
      Reactions.event(room, room.turn, "good", reactBump, 1600);
      for (const c of new Set(capturedList.map((x) => x.c))) Reactions.event(room, room.players.findIndex((q) => q.color === c), "bad", reactBump, 1600);
    }
    if (toks.every((p) => p === finish)) Reactions.event(room, room.turn, "win", reactBump, 1600);   // once the app has walked the token there
    const iFinished = toks.every((p) => p === finish);
    if (iFinished && room.teamMode) {
      const mateSeat = room.teamOf.findIndex((t, s) => s !== room.turn && t === room.teamOf[room.turn]);
      const mate = room.players[mateSeat];
      const mateDone = room.tokens[mate.color].every((p) => p === finish);
      if (mateDone) {
        room.status = "over";
        room.winner = color;
        room.winnerTeam = [mate.color, color];
        room.log = `${mate.name} and ${pl.name} got everything home. Their team wins!`;
        room.turnEndsAt = null;
        clearTimer(room.code);
      } else {
        room.log = `${pl.name} is all done! Their team wins when ${mate.name} finishes too.`;
        passTurn(room);
      }
    } else if (iFinished) {
      room.status = "over";
      room.winner = color;
      room.log = `${pl.name} got every piece home and wins!`;
      room.turnEndsAt = null;
      clearTimer(room.code);
    } else {
      const extra = die === 6 || capturedList.length > 0 || gotHome;
      if (capturedNames.length > 0) room.log = `${pl.name} captured ${capturedNames.join(" and ")}! Roll again.`;
      else if (gotHome) room.log = `${pl.name} got a piece home! Roll again.`;
      else if (die === 6) room.log = `${pl.name} moved. A 6 means roll again.`;
      else room.log = `${pl.name} moved.`;
      if (blocked.length && !capturedNames.length) {
        const names = [...new Set(blocked.map((b) => (room.players.find((q) => q.color === b.c) || {}).name).filter(Boolean))];
        room.log = `Blocked! ${names.join(" and ")}'s shield held.` + (extra ? " Roll again." : "");
      }
      if (extra) { room.phase = "roll"; room.die = null; }
      else passTurn(room);
    }
    room.touched = Date.now();
    sendState(room.code);
    if (room.status === "playing") armTimer(room.code);
}

function performRoll(room, opts) {
  const pl = room.players[room.turn];
  const val = room.testDice && room.testDice.length ? room.testDice.shift() : crypto.randomInt(1, 7);   // testDice: the tests' own rolls (TEST_HOOKS only)
  if (room.pw) room.pw.sixesBefore = room.sixes;   // a re-roll throws this roll away, its six too
  room.die = val;
  room.sixes = val === 6 ? room.sixes + 1 : 0;
  if (val === 6 && room.sixes >= 3) {
    room.log = `${pl.name} rolled three 6s in a row. Turn lost!`;
    passTurn(room);
  } else {
    room.phase = "move";
    const lm = legalMoves(room);
    if (lm.length === 0) {
      if (val === 6) {
        room.log = `${pl.name} rolled 6 but nothing can move. Roll again.`;
        room.phase = "roll"; room.die = null;
      } else {
        room.log = `${pl.name} rolled ${val}. No moves.`;
        if (!(opts && opts.auto) && holdFor(room)) room.turnEndsAt = room.pw.hold = Date.now() + POWER_HOLD_MS;   // Power mode: the pass waits for the re-roll key (armTimer)
        else passTurn(room);
      }
    } else {
      room.log = `${pl.name} rolled ${val}. Pick a piece.`;
    }
  }
  room.v++;
  room.touched = Date.now();
  sendState(room.code);
  armTimer(room.code);
}

const BOT_DELAY_OVERRIDE = process.env.BOT_DELAY_MS !== undefined && process.env.BOT_DELAY_MS !== "";
const BOT_DELAY_MS = Math.max(1, Number(process.env.BOT_DELAY_MS || 650));

/* How long a bot takes (pacing round 1, 2026-11-01). The owner's phone log: a bot's turn held 1.6 s at the median and the
   three bots of a four-seat game kept a person waiting 5 s; and no two waits alike would read as a person, not a clock. So each
   action takes what it asks, every one jittered: a roll 0.5-0.9 s; a move that is forced 0.1-0.25 s, a capture, a home run or
   a piece out on a six 0.35-0.8 s, a rescue 0.6-1.0 s, a calm choice among several 0.6-1.25 s. Never over BOT_MAX_MS (2.2 s):
   and BOT_STALL_MS (3 s) after its time is up, a bot that has not acted is made to (botWatch), so a lost timer or an
   exception in a move can never leave a table waiting for the 60-second turn clock. BOT_DELAY_MS (tests) keeps the old flat wait. */
const BOT_MAX_MS = 2200, BOT_STALL_MS = Math.max(100, Number(process.env.BOT_STALL_MS || 3000));
const jit = (lo, hi) => lo + Math.random() * (hi - lo);
const MOVE_WAIT = { capture: [450, 800], finish: [400, 700], out: [350, 650], rescue: [600, 1000], safe: [600, 1200], advance: [650, 1250] };
function botDelay(room) {
  const flat = BOT_DELAY_MS + Math.floor(Math.random() * Math.max(1, BOT_DELAY_MS));
  if (BOT_DELAY_OVERRIDE) return flat;
  if (room.phase !== "move") return Math.round(jit(500, 900));
  let lm = [];
  try { lm = legalMoves(room); } catch (e) { /* a roll's wait */ }
  if (lm.length <= 1) return Math.round(jit(100, 250));
  let why = "advance";
  try { why = botDecide(room, lm).why; } catch (e) { /* the middle of the range */ }
  const [lo, hi] = MOVE_WAIT[why] || MOVE_WAIT.advance;
  return Math.min(BOT_MAX_MS, Math.round(jit(lo, hi)));
}
const botTimers = new Map();
const botWatches = new Map();
const BOT_NAMES = ["Robo", "Chip", "Bolt", "Dicey", "Turbo", "Pixel", "Gizmo", "Widget"];
/* What the bots have done, for the tests and the log: how many actions the watchdog had to make. */
const botStats = { actions: 0, watchdog: 0, failed: 0 };

function clearBotTimer(code) {
  const t = botTimers.get(code);
  if (t) { clearTimeout(t); botTimers.delete(code); }
  const w = botWatches.get(code);
  if (w) { clearTimeout(w); botWatches.delete(code); }
}

/* One bot action: its roll, or its move (a pass if none can move). Whatever goes wrong in it, the table is not left waiting:
   the whole turn is played the way a timed-out one is. */
function botAction(r) {
  try {
    if (botPower(r)) { botStats.actions++; return; }   // Power mode: a power-up is an action of its own; the roll or the move follows it
    if (r.phase === "roll") {
      performRoll(r);
    } else if (r.phase === "move") {
      const lm = legalMoves(r);
      if (lm.length) {
        performMove(r, botPick(r, lm));
      } else {
        passTurn(r);
        r.v++;
        r.touched = Date.now();
        sendState(r.code);
        armTimer(r.code);
      }
    }
    botStats.actions++;
  } catch (e) {
    botStats.failed++;
    console.error(`[${new Date().toISOString()}] ludo bot action failed in ${r.code}:`, (e && e.stack) || e);
    try { autoPlayTurn(r); } catch (e2) { console.error("ludo bot fallback failed:", (e2 && e2.stack) || e2); }
  }
}

function scheduleBot(code) {
  clearBotTimer(code);
  const room = rooms.get(code);
  if (!room || room.status !== "playing") return;
  const pl = room.players[room.turn];
  if (!pl || !(pl.bot || pl.botControlled)) return;
  // Where the table is, apart from chat and reactions (which move v too): the same place when the watchdog looks is a stall.
  const where = (r) => `${r.turn}|${r.phase}|${r.die}|${r.sixes}|${r.lastMove ? r.lastMove.mv : 0}|${r.pw ? r.pw.seq : 0}`;
  const at0 = where(room);
  const delay = botDelay(room);
  const isBot = (r) => { const cur = r.players[r.turn]; return !!cur && !!(cur.bot || cur.botControlled); };
  botTimers.set(code, setTimeout(() => {
    botTimers.delete(code);
    const r = rooms.get(code);
    if (!r || r.status !== "playing" || !isBot(r)) return;
    botAction(r);
  }, delay));
  // The watchdog: if this action has not happened BOT_STALL_MS after its time, it is made to.
  botWatches.set(code, setTimeout(() => {
    botWatches.delete(code);
    const r = rooms.get(code);
    if (!r || r.status !== "playing" || !isBot(r) || where(r) !== at0) return;
    botStats.watchdog++;
    console.warn(`[${new Date().toISOString()}] ludo bot ${code}: no action ${delay + BOT_STALL_MS} ms after its turn began; the watchdog plays it`);
    clearBotTimer(code);
    botAction(r);
  }, delay + BOT_STALL_MS));
}

/* T8: risk-aware bot. Priorities, first match wins:
   1. capture — prefer multi-captures, then the enemy token furthest along
   2. finish a token exactly
   3. rescue a threatened token (an enemy 1–6 cells behind it on a non-safe cell) onto a safe cell or into the home lane
   4. bring a token out on a six
   5. land on a safe cell or enter the home lane
   6. advance the furthest track token whose destination is not threatened; otherwise the lowest-risk move
      (never leave a safe cell for a threatened one when a calmer move exists); track tokens before lane tokens. */
function enemyColorsOf(room, color) {
  return Object.keys(room.tokens).filter((c) => {
    if (c === color) return false;
    if (room.teamMode && room.teamOf) { const vSeat = room.players.findIndex((q) => q.color === c); if (vSeat >= 0 && room.teamOf[vSeat] === room.teamOf[room.turn]) return false; }
    return true;
  });
}
function botPick(room, lm) { return botDecide(room, lm).i; }
/* The same pick, with the reason it was made (the pacing: a capture or a home run is a quick, glad move, a calm advance among
   several is a thought): { i, why } with why one of capture, finish, rescue, out, safe, advance. */
function botDecide(room, lm) {
  const cfg = room.cfg;
  const color = room.players[room.turn].color;
  const die = room.die + (stepping(room) ? 1 : 0);   // Power mode's extra step moves the roll plus one
  const finish = cfg.M + 4;
  const trackEnd = cfg.M - 2;
  const safeSet = new Set(cfg.safe);
  const toks = room.tokens[color];
  const onTrack = (p) => p >= 0 && p <= trackEnd;
  const absOf = (c, p) => (cfg.starts[c] + p) % cfg.M;
  const lands = (i) => (toks[i] === -1 ? 0 : toks[i] + die);
  const enemyToks = [];
  for (const c of enemyColorsOf(room, color)) room.tokens[c].forEach((p, i) => { if (onTrack(p)) enemyToks.push({ c, i, p, abs: absOf(c, p) }); });
  const capturesAt = (abs) => (safeSet.has(abs) ? [] : enemyToks.filter((e) => e.abs === abs));
  const threatAt = (abs) => (safeSet.has(abs) ? 0 : enemyToks.filter((e) => { const d = (abs - e.abs + cfg.M) % cfg.M; return d >= 1 && d <= 6; }).length);
  const dest = (i) => { const to = lands(i); const abs = onTrack(to) ? absOf(color, to) : null; return { to, abs, safe: abs == null || safeSet.has(abs), risk: abs == null ? 0 : threatAt(abs) }; };
  const isTrack = (i) => onTrack(toks[i]);
  const leavesSafe = (i) => (isTrack(i) && safeSet.has(absOf(color, toks[i])) ? 1 : 0);
  const furthest = (arr) => arr.reduce((a, b) => (toks[a] >= toks[b] ? a : b));
  // 1. capture
  let best = null, bestScore = -1;
  for (const i of lm) {
    const d = dest(i); if (d.abs == null) continue;
    const caps = capturesAt(d.abs); if (!caps.length) continue;
    const score = caps.length * 1000 + Math.max(...caps.map((e) => e.p));
    if (score > bestScore) { bestScore = score; best = i; }
  }
  if (best != null) return { i: best, why: "capture" };
  // 2. exact finish
  for (const i of lm) if (lands(i) === finish) return { i, why: "finish" };
  // 3. rescue
  const rescues = lm.filter((i) => isTrack(i) && threatAt(absOf(color, toks[i])) > 0 && dest(i).safe);
  if (rescues.length) return { i: furthest(rescues), why: "rescue" };
  // 4. out on a six
  for (const i of lm) if (toks[i] === -1) return { i, why: "out" };
  // 5. safe landing / lane entry
  const safes = lm.filter((i) => isTrack(i) && dest(i).safe);
  if (safes.length) return { i: furthest(safes), why: "safe" };
  // 6. calm advance, else lowest risk
  const order = lm.slice().sort((a, b) => (dest(a).risk - dest(b).risk) || (leavesSafe(a) - leavesSafe(b)) || (isTrack(b) - isTrack(a)) || (toks[b] - toks[a]));
  return { i: order[0], why: "advance" };
}

function addBotTo(room) {
  const taken = room.players.map((q) => q.color);
  const color = ASSIGN.find((c) => !taken.includes(c));
  if (!color) return null;
  const used = room.players.map((q) => q.name);
  const name = BOT_NAMES.find((n) => !used.includes(n)) || ("Bot" + (room.players.length + 1));
  const p = { id: "bot_" + newId(), name, color, left: false, connected: true, avatar: "\u{1F916}", bot: true };
  room.players.push(p);
  return p;
}


/* T3: the host seat follows the humans — first connected human, else first human still seated, else unchanged. */
function ensureHost(room) {
  const cur = room.players.find((p) => p.id === room.host);
  if (cur && !cur.bot && !cur.left && cur.connected) return false;
  const next = room.players.find((p) => !p.bot && !p.left && p.connected) || room.players.find((p) => !p.bot && !p.left);
  if (!next || next.id === room.host) return false;
  room.host = next.id;
  room.log = `${next.name} is now the host.`;
  modeFollowsHost(room);
  return true;
}
/* Power mode is hosted only by an app that knows it: a lobby whose host is now an older app is a Classic one again. */
function modeFollowsHost(room) {
  if (room.status !== "lobby" || room.mode !== "power") return;
  const host = room.players.find((p) => p.id === room.host);
  if (host && host.pw && host.pw.knows) return;
  room.mode = "classic";
}

Quick.init({ game: 'ludo', model: 'openskill', seats: 4, codeKey: 'roomCode', app, io, rooms, base: BASE, broadcast: sendState, winners: (r) => { const i = r.players.findIndex((p) => p.color === r.winner); return i < 0 ? [] : [i]; }, rated: (r) => !r.teamMode && r.mode !== "power",   // a Power game is never rated: money never moves a rating
  accept: (room, payload) => (room.mode === "power") === (payload.mode === "power" && Power.knows(payload.caps)) });   // quick play matches Power only with Power
io.on("connection", (socket) => {
  Plus.guardSocket(socket);   // the wallet's signed entitlement: every event's `plus` is the checked answer (the Nest Wallet repo, contrib/ROLLOUT.md)
  Quick.hook(socket); Quick.connection(socket);   // before the server's own events
  const on = guarded(socket);   // every client event below goes through the guard
  const currentRoom = () => rooms.get(socket.data.roomCode);
  Reactions.wire({ on, room: currentRoom, me: () => socket.data.playerId, isHost: (r) => r.host === socket.data.playerId, bump: reactBump });
  const me = () => {
    const r = currentRoom();
    return r ? r.players.find((p) => p.id === socket.data.playerId) : null;
  };

  on("create", ({ name, playerId, avatar, plus, look, crew, caps, power, mode } = {}) => {
    name = cleanName(name);
    if (!name) return socket.emit("err", "Please enter a name.");
    let code = genCode();
    let guard = 0;
    while (rooms.has(code) && guard++ < 10) code = genCode();
    code = Plus.crewCode({ plus, crew }, rooms, () => code);   // GameNest Plus's crew code (2026-10-17)
    const id = playerId || newId();
    socket.data.playerId = id;
    const room = {
      v: 1, code, host: id, status: "lobby",
      players: [{ id, name, color: "red", left: false, connected: true, avatar: cleanAvatar(avatar), pw: Power.seat(caps, power) }],
      mode: mode === "power" && Power.knows(caps) ? "power" : "classic",   // Power mode from the start is quick play's; a private room's host picks it in the lobby (settings)
      turn: 0, phase: "roll", die: null, sixes: 0,
      tokens: {}, winner: null, cfg: null, tokenChoice: 4, teamChoice: false,
      chat: [], lastMove: null,
      log: "Share the code with your friends.",
      turnEndsAt: null, touched: Date.now(),
    };
    rooms.set(code, room);
    attach(socket, code);
    stampPlus(code, socket, { plus, look }); socket.emit("joined", { code, playerId: id });
    sendState(code);
  });

  on("join", ({ code, name, playerId, avatar, plus, look, caps, power } = {}) => {
    code = String(code || "").trim().toUpperCase();
    name = cleanName(name);
    const room = rooms.get(code);
    if (!room) return socket.emit("err", "Room not found. Check the code.");
    let p = playerId ? room.players.find((q) => q.id === playerId) : null;
    if (p) {
      p.connected = true;
      p.left = false;
      humanIsBack(room, p, "reconnected");
      if (room.status === "playing" && room.players[room.turn] === p) armTimer(code);   // back on the normal clock
      if (name) p.name = name;
      if (avatar) p.avatar = cleanAvatar(avatar);
      socket.data.playerId = p.id;
      if (!p.pw) p.pw = Power.seat(caps, null);
      if (caps !== undefined) p.pw.knows = Power.knows(caps);
      Power.take(p.pw, power, room.pw && room.pw.game);   // back with their stock as their phone has it
    } else {
      if (!name) return socket.emit("err", "Please enter a name.");
      if (room.status !== "lobby") {
        // A game under way: an app that knows the line waits in it; an older one hears the game has started.
        if (!(Array.isArray(caps) && caps.includes("waitList"))) return socket.emit("err", "That game already started.");
        const id = playerId || newId();
        socket.data.playerId = id;
        room.waiting = room.waiting || [];
        if (!room.waiting.some((q) => q.id === id)) {
          if (room.waiting.length >= MAX_PLAYERS) return socket.emit("err", "Room is full.");
          room.waiting.push({ id, name, avatar: cleanAvatar(avatar), plus: plus === true, acct: Plus.acctOf(socket), look: Plus.cleanLook(look), pw: Power.seat(caps, power) });
          room.log = `${name} is waiting for a seat.`;
        }
        attach(socket, code);
        socket.emit("joined", { code, playerId: id, waiting: true });
        takeLeftSeats(room);
        room.v++;
        room.touched = Date.now();
        sendState(code);
        return;
      }
      if (room.players.length >= MAX_PLAYERS) return socket.emit("err", `Room is full (${MAX_PLAYERS} players max).`);
      const taken = room.players.map((q) => q.color);
      const color = ASSIGN.find((c) => !taken.includes(c));
      const id = playerId || newId();
      socket.data.playerId = id;
      p = { id, name, color, left: false, connected: true, avatar: cleanAvatar(avatar), pw: Power.seat(caps, power) };
      room.players.push(p);
      room.log = `${name} joined.`;
    }
    room.v++;
    room.touched = Date.now();
    attach(socket, code);
    stampPlus(code, socket, { plus, look }); socket.emit("joined", { code, playerId: p.id });
    sendState(code);
  });
  on("pushToken", ({ token } = {}) => { const room = currentRoom(); if (!room) return; const p = room.players.find((q) => q.id === socket.data.playerId); if (p && typeof token === "string" && /^[0-9a-f]{32,200}$/i.test(token)) p.pushToken = token; });
  on("presence", ({ away } = {}) => { const room = currentRoom(); if (!room) return; const p = room.players.find((q) => q.id === socket.data.playerId); if (p) p.away = !!away; });


  on("chat", ({ text, sticker } = {}) => {
    const room = currentRoom();
    const p = me();
    if (!room || !p) return;
    const now = Date.now();
    if (now - (socket.data.lastChat || 0) < CHAT_COOLDOWN_MS) return;
    let msg = null;
    if (sticker) {
      if (!STICKERS.includes(sticker)) return;
      msg = { k: "s", s: sticker };
    } else {
      text = cleanChat(text);
      if (!text) return;
      msg = { k: "t", x: text };
    }
    socket.data.lastChat = now;
    const finish = () => {
      const room = rooms.get(code), p = room && room.players.find((q) => q.id === pid);   // gone while it was read
      if (!p) return;
      msg.n = p.name; msg.c = p.color; msg.a = p.avatar; msg.t = now;
      room.chat.push(msg); if (msg && msg.k === "t") for (const q of room.players) if (q !== p) pushTo(q, p.name + ": " + msg.x, { code: room.code, game: PUSH_TITLE }, room.code + "-chat");
      if (room.chat.length > CHAT_KEEP) room.chat.shift();
      room.v++;
      room.touched = Date.now();
      sendState(room.code);
    };
    const code = room.code, pid = p.id;
    if (msg.k === "t") Moderation.chat(msg.x).then((shown) => { msg.x = shown; finish(); }); else finish();
  });

  on("settings", ({ tokens, team, board, mode } = {}) => {
    const room = currentRoom();
    if (!room || room.status !== "lobby") return;
    if (room.host !== socket.data.playerId) return;
    let changed = false;
    if ((mode === "classic" || mode === "power") && mode !== (room.mode || "classic") && !room.quick) {   // a quick room keeps the mode it was matched on
      const host = me();
      if (mode === "power" && !(host && host.pw && host.pw.knows)) return socket.emit("refusal", { code: "power", message: "Update GameNest to play Power mode.", op: "settings" });
      room.mode = mode;
      room.log = mode === "power" ? "Power mode: power-ups on. No coin tables." : "Classic mode.";
      changed = true;
    }
    if (typeof board === "string" && BOARDS.includes(board) && board !== (room.board || "classic")) {
      if (board !== "classic" && !Plus.isPlusRoom(room)) return socket.emit("refusal", { code: "plus", message: "The Plus boards come with GameNest Plus.", op: "settings" });
      room.board = board;
      room.log = board === "classic" ? "The classic board." : `The ${{ candy: "Candy Land", palace: "Golden Palace", galaxy: "Galaxy" }[board]} board.`;
      changed = true;
    }
    if ([2, 3, 4].includes(tokens)) {
      room.tokenChoice = tokens;
      room.log = `Tokens per player set to ${tokens}.`;
      changed = true;
    }
    if (typeof team === "boolean") {
      room.teamChoice = team;
      room.log = team ? "Team mode on: 2v2, partners sit opposite." : "Team mode off.";
      changed = true;
    }
    if (!changed) return;
    room.v++;
    room.touched = Date.now();
    sendState(room.code);
  });

  on("addBot", () => {
    const room = currentRoom();
    if (!room || room.status !== "lobby") return;
    if (room.host !== socket.data.playerId) return;
    if (room.players.length >= MAX_PLAYERS) return;
    const b = addBotTo(room);
    if (!b) return;
    room.log = `${b.name} (bot) joined.`;
    room.v++;
    room.touched = Date.now();
    sendState(room.code);
  });

  on("removeBot", () => {
    const room = currentRoom();
    if (!room || room.status !== "lobby") return;
    if (room.host !== socket.data.playerId) return;
    for (let i = room.players.length - 1; i >= 0; i--) {
      if (room.players[i].bot) {
        room.log = `${room.players[i].name} (bot) removed.`;
        room.players.splice(i, 1);
        break;
      }
    }
    room.v++;
    room.touched = Date.now();
    sendState(room.code);
  });

  on("start", () => {
    const room = currentRoom();
    if (!room || room.status !== "lobby") return;
    if (room.host !== socket.data.playerId) return;
    if (room.players.filter((p) => !p.left).length < 2) return socket.emit("err", "You need at least 2 players.");
    if (room.teamChoice && room.players.length === 3) addBotTo(room);
    if (room.teamChoice && room.players.length !== 4) return socket.emit("err", "Team mode needs 4 seats. Add bots to fill.");
    modeFollowsHost(room);
    setupGame(room);
    if (room.teamMode) {
      const t0 = room.players.filter((p, s) => room.teamOf[s] === 0).map((p) => p.name).join(" & ");
      const t1 = room.players.filter((p, s) => room.teamOf[s] === 1).map((p) => p.name).join(" & ");
      room.log = `Teams drawn: ${t0} vs ${t1}. ${room.players[0].name} rolls first.`;
    } else {
      room.log = `${room.players[0].name} rolls first. Roll a 6 to bring a piece out.`;
    }
    if (room.recolourNote) room.log += " " + room.recolourNote;
    room.v++;
    room.touched = Date.now();
    sendState(room.code);
    armTimer(room.code);
  });

  on("roll", () => {
    const room = currentRoom();
    if (!room || room.status !== "playing") return;
    const self = me();
    if (self && humanIsBack(room, self, "took the seat back")) { clearBotTimer(room.code); room.touched = Date.now(); sendState(room.code); }   // any action reclaims a bot-controlled seat
    if (room.phase !== "roll") return;
    const pl = room.players[room.turn];
    if (pl.id !== socket.data.playerId) return;
    performRoll(room);
  });

  on("move", ({ i } = {}) => {
    const room = currentRoom();
    if (!room || room.status !== "playing") return;
    const self = me();
    if (self && humanIsBack(room, self, "took the seat back")) { clearBotTimer(room.code); room.touched = Date.now(); sendState(room.code); }
    if (room.phase !== "move") return;
    const pl = room.players[room.turn];
    if (pl.id !== socket.data.playerId) return;
    performMove(room, i);
  });



  /* Power mode: one message to use a power-up ({ kind, i } with i the pawn for a shield when more than one can take it). */
  on("power", ({ kind, i } = {}) => {
    const room = currentRoom();
    if (!room || room.status !== "playing") return;
    const refuse = (message) => socket.emit("refusal", { code: "power", message, op: "power" });
    if (room.mode !== "power") return refuse("Power-ups are for Power rooms.");   // a Classic room never takes one, whatever the app sends
    const self = me();
    if (!self) return;
    if (humanIsBack(room, self, "took the seat back")) { clearBotTimer(room.code); room.touched = Date.now(); sendState(room.code); }
    if (room.players[room.turn].id !== socket.data.playerId) return refuse("Wait for your turn.");
    const why = usePower(room, kind, i);
    if (why) refuse(why);
  });
  /* What the player owns now (they bought a pack, or the starter gift arrived): the same payload as on join. */
  on("powerStock", (payload) => {
    const room = currentRoom();
    const self = me() || (room && (room.waiting || []).find((w) => w.id === socket.data.playerId));   // someone waiting in line keeps theirs up to date too
    if (!room || !self || !self.pw) return;
    if (!Power.take(self.pw, payload, room.pw && room.pw.game)) return;
    room.v++;
    room.touched = Date.now();
    sendState(room.code);
  });
  if (process.env.TEST_HOOKS === "1") on("__test", ({ dice, tokens, turn } = {}) => {   // test-only: the next rolls, a staged position, whose turn it is
    const room = currentRoom();
    if (!room || room.status !== "playing") return;
    if (Array.isArray(dice)) room.testDice = dice.filter((d) => Number.isInteger(d) && d >= 1 && d <= 6).slice(0, 200);
    if (tokens && typeof tokens === "object") for (const [c, arr] of Object.entries(tokens)) if (room.tokens[c] && Array.isArray(arr) && arr.length === room.tokens[c].length) room.tokens[c] = arr.map(Number);
    if (Number.isInteger(turn) && room.players[turn]) { passTurn(room); room.turn = turn; }
    room.v++;
    room.touched = Date.now();
    sendState(room.code);
    armTimer(room.code);
  });

  on("takeSeat", () => {
    const room = currentRoom(); const p = me();
    if (!room || !p) return;
    if (humanIsBack(room, p, "took the seat back")) { room.touched = Date.now(); sendState(room.code); }
  });

  on("rematch", () => {
    const room = currentRoom();
    if (!room || room.status !== "over") return;
    if (room.host !== socket.data.playerId) return;
    if (room.players.filter((p) => !p.left).length < 2) return socket.emit("err", "Not enough players left for a rematch.");
    setupGame(room);
    room.log = `Rematch! ${room.players[0].name} rolls first.` + (room.recolourNote ? " " + room.recolourNote : "");
    room.v++;
    room.touched = Date.now();
    sendState(room.code);
    armTimer(room.code);
  });

  function handleLeave() {
    const room = currentRoom();
    const p = me();
    if (room && !p && room.waiting && room.waiting.some((w) => w.id === socket.data.playerId)) {
      // Out of the waiting line.
      room.waiting = room.waiting.filter((w) => w.id !== socket.data.playerId);
      detach(socket);
      room.v++;
      sendState(room.code);
      return;
    }
    if (!room || !p) { detach(socket); return; }
    if (room.status === "lobby") {
      room.players = room.players.filter((q) => q.id !== p.id);
      if (room.voice) room.voice.clear();
      if (room.players.length > 0 && room.players.every((q) => q.bot)) {
        detach(socket);
        deleteRoom(room.code);
        return;
      }
      if (room.players.length === 0) {
        detach(socket);
        deleteRoom(room.code);
        return;
      }
      if (room.host === p.id) { room.host = (room.players.find((q) => !q.bot) || room.players[0]).id; modeFollowsHost(room); }
      room.log = `${p.name} left the lobby.`;
    } else {
      p.left = true;
      p.connected = false;
      dropVoice(room, p.id);
      room.log = `${p.name} left the game.`;
      // The first in line takes the seat before anything is decided for want of players.
      takeLeftSeats(room);
      ensureHost(room);
      if (room.players.every((q) => q.bot || q.left)) {
        detach(socket);
        deleteRoom(room.code);
        return;
      }
      const finish = room.cfg.M + 4;
      const active = room.players.filter(
        (q) => !q.left && !room.tokens[q.color].every((t) => t === finish)
      );
      if (room.status === "playing" && active.length === 1) {
        room.status = "over";
        room.winner = active[0].color;
        if (room.teamMode) {
          const wSeat = room.players.findIndex((q) => q.color === active[0].color);
          const mSeat = room.teamOf ? room.teamOf.findIndex((t, s) => s !== wSeat && t === room.teamOf[wSeat]) : -1;
          room.winnerTeam = mSeat >= 0 ? [room.players[mSeat].color, active[0].color] : null;
        }
        room.log = `${active[0].name} wins. Everyone else left.`;
        room.turnEndsAt = null;
        clearTimer(room.code);
      } else if (room.status === "playing" && room.players[room.turn].id === p.id) {
        passTurn(room);
        armTimer(room.code);
      }
    }
    room.v++;
    room.touched = Date.now();
    detach(socket);
    sendState(room.code);
  }

  function dropVoice(room, pid) {
    if (!room || !room.voice) return;
    const seat = room.players.findIndex((q) => q.id === pid);
    if (seat >= 0) room.voice.delete(seat);
  }

  on("voice", ({ kind, to, data } = {}) => {
    const room = currentRoom();
    if (!room) return;
    const seat = room.players.findIndex((p) => p.id === socket.data.playerId);
    if (seat < 0) return;
    if (kind === "join" || kind === "leave") {
      if (!room.voice) room.voice = new Set();
      if (kind === "join") room.voice.add(seat);
      else room.voice.delete(seat);
      room.v++;
      room.touched = Date.now();
      sendState(room.code);
      return;
    }
    if (kind === "signal" && Number.isInteger(to) && data) {
      let size = 0;
      try { size = JSON.stringify(data).length; } catch (e) { return; }
      if (size > 20000) return;
      const sockets = roomSockets.get(room.code);
      if (!sockets) return;
      for (const s of sockets) {
        const sSeat = room.players.findIndex((p) => p.id === s.data.playerId);
        if (sSeat === to) s.emit("voice", { kind: "signal", from: seat, data });
      }
    }
  });

  on("leave", () => handleLeave());

  socket.on("disconnect", () => {
    const room = currentRoom();
    const p = me();
    // A watcher in the waiting line who goes away leaves the line (they can join again).
    if (room && !p && room.waiting && room.waiting.some((w) => w.id === socket.data.playerId)) {
      room.waiting = room.waiting.filter((w) => w.id !== socket.data.playerId);
      detach(socket); room.v++; sendState(room.code); return;
    }
    if (!room || !p) { detach(socket); return; }
    if (room.status === "lobby") {
      handleLeave();
      return;
    }
    p.connected = false;
    dropVoice(room, p.id);
    ensureHost(room);
    room.v++;
    detach(socket);
    sendState(room.code);
    if (room.status === "playing" && room.players[room.turn] === p) armTimer(room.code);   // 5 s clock while they are away
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.touched > ROOM_IDLE_MS) deleteRoom(code);
  }
}, 10 * 60e3);

if (require.main === module) server.listen(PORT, () => {
  console.log(`Ludo Rooms running on port ${PORT}`);
});
module.exports = { buildConfig, legalMoves, botPick, botDecide, botDelay, botAction, botStats, rooms, scheduleBot, botTimers, botWatches,
  Power, setupPower, powerCan, powerView, powerMe, usePower, botPower, holdFor, endHold, performRoll, performMove, publicRoom, timers };
