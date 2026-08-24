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

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const ROOM_IDLE_MS = 2 * 3600e3;
const MAX_PLAYERS = 10;
const CHAT_KEEP = 60;
const CHAT_COOLDOWN_MS = 800;

const ORDER = ["red","green","yellow","blue","orange","purple","teal","pink","lime","brown"];
const ASSIGN = ["red","yellow","green","blue","orange","purple","teal","pink","lime","brown"];
const STICKERS = ["lol","cry","fire","dice","snail","devil","pray","skull","party","angry","pinch","run"];
const AVATARS = ["\u{1F60E}","\u{1F913}","\u{1F451}","\u{1F42F}","\u{1F43C}","\u{1F98A}","\u{1F47D}","\u{1F916}","\u{1F355}","\u{1F438}","\u{1F984}","\u{1F4A9}"];

const rooms = new Map();
const timers = new Map();
const roomSockets = new Map();

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function genCode() {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return s;
}
const newId = () => crypto.randomBytes(8).toString("hex");
const cleanName = (n) => String(n || "").replace(/[<>&"'`]/g, "").trim().slice(0, 14);
const cleanChat = (n) => String(n || "").replace(/[<>&"'`]/g, "").trim().slice(0, 140);
const cleanAvatar = (a) => (AVATARS.includes(a) ? a : "\u{1F642}");

/* Positions per token: -1 base, 0..M-2 shared track, M-1..M+3 home lane,
   M+4 finished. Classic board is M=52 (track 0..50, lane 51..55, done 56). */
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

function passTurn(room) {
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
  const ms = room.players.length >= 6 ? 45000 : 60000;
  room.turnEndsAt = Date.now() + ms;
  timers.set(code, setTimeout(() => {
    const r = rooms.get(code);
    if (!r || r.status !== "playing") return;
    r.log = `${r.players[r.turn].name} ran out of time. Turn skipped.`;
    r.v++;
    passTurn(r);
    r.touched = Date.now();
    sendState(code);
    armTimer(code);
  }, ms));
}

function publicRoom(room) {
  return {
    code: room.code,
    status: room.status,
    players: room.players.map((p) => ({
      name: p.name, color: p.color, left: p.left, connected: p.connected, avatar: p.avatar, bot: !!p.bot,
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
  };
}

function sendState(code) {
  const room = rooms.get(code);
  const sockets = roomSockets.get(code);
  if (!room || !sockets) return;
  const pub = publicRoom(room);
  for (const s of sockets) {
    const mySeat = room.players.findIndex((p) => p.id === s.data.playerId);
    s.emit("state", { room: pub, mySeat });
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

function setupGame(room) {
  room.players = room.players.filter((p) => !p.left);
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
    const to = from === -1 ? 0 : from + die;
    toks[i] = to;

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
      if (extra) { room.phase = "roll"; room.die = null; }
      else passTurn(room);
    }
    room.touched = Date.now();
    sendState(room.code);
    if (room.status === "playing") armTimer(room.code);
}

function performRoll(room) {
  const pl = room.players[room.turn];
  const val = crypto.randomInt(1, 7);
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
        passTurn(room);
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

const BOT_DELAY_MS = Math.max(1, Number(process.env.BOT_DELAY_MS || 650));
const botTimers = new Map();
const BOT_NAMES = ["Robo", "Chip", "Bolt", "Dicey", "Turbo", "Pixel", "Gizmo", "Widget"];

function clearBotTimer(code) {
  const t = botTimers.get(code);
  if (t) { clearTimeout(t); botTimers.delete(code); }
}

function scheduleBot(code) {
  clearBotTimer(code);
  const room = rooms.get(code);
  if (!room || room.status !== "playing") return;
  const pl = room.players[room.turn];
  if (!pl || !pl.bot) return;
  botTimers.set(code, setTimeout(() => {
    botTimers.delete(code);
    const r = rooms.get(code);
    if (!r || r.status !== "playing") return;
    const cur = r.players[r.turn];
    if (!cur || !cur.bot) return;
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
        sendState(code);
        armTimer(code);
      }
    }
  }, BOT_DELAY_MS + Math.floor(Math.random() * Math.max(1, BOT_DELAY_MS))));
}

function botPick(room, lm) {
  const cfg = room.cfg;
  const color = room.players[room.turn].color;
  const die = room.die;
  const finish = cfg.M + 4;
  const trackEnd = cfg.M - 2;
  const safeSet = new Set(cfg.safe);
  const toks = room.tokens[color];
  const lands = (i) => (toks[i] === -1 ? 0 : toks[i] + die);
  for (const i of lm) {
    const to = lands(i);
    if (to >= 0 && to <= trackEnd) {
      const abs = (cfg.starts[color] + to) % cfg.M;
      if (!safeSet.has(abs)) {
        for (const c of Object.keys(room.tokens)) {
          if (c === color) continue;
          if (room.teamMode && room.teamOf) {
            const vSeat = room.players.findIndex((q) => q.color === c);
            if (vSeat >= 0 && room.teamOf[vSeat] === room.teamOf[room.turn]) continue;
          }
          if (room.tokens[c].some((p) => p >= 0 && p <= trackEnd && (cfg.starts[c] + p) % cfg.M === abs)) return i;
        }
      }
    }
  }
  for (const i of lm) if (lands(i) === finish) return i;
  for (const i of lm) if (toks[i] === -1) return i;
  let best = lm[0];
  for (const i of lm) if (toks[i] > toks[best]) best = i;
  return best;
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

io.on("connection", (socket) => {
  const currentRoom = () => rooms.get(socket.data.roomCode);
  const me = () => {
    const r = currentRoom();
    return r ? r.players.find((p) => p.id === socket.data.playerId) : null;
  };

  socket.on("create", ({ name, playerId, avatar } = {}) => {
    name = cleanName(name);
    if (!name) return socket.emit("err", "Please enter a name.");
    let code = genCode();
    let guard = 0;
    while (rooms.has(code) && guard++ < 10) code = genCode();
    const id = playerId || newId();
    socket.data.playerId = id;
    const room = {
      v: 1, code, host: id, status: "lobby",
      players: [{ id, name, color: "red", left: false, connected: true, avatar: cleanAvatar(avatar) }],
      turn: 0, phase: "roll", die: null, sixes: 0,
      tokens: {}, winner: null, cfg: null, tokenChoice: 4, teamChoice: false,
      chat: [], lastMove: null,
      log: "Share the code with your friends.",
      turnEndsAt: null, touched: Date.now(),
    };
    rooms.set(code, room);
    attach(socket, code);
    socket.emit("joined", { code, playerId: id });
    sendState(code);
  });

  socket.on("join", ({ code, name, playerId, avatar } = {}) => {
    code = String(code || "").trim().toUpperCase();
    name = cleanName(name);
    const room = rooms.get(code);
    if (!room) return socket.emit("err", "Room not found. Check the code.");
    let p = playerId ? room.players.find((q) => q.id === playerId) : null;
    if (p) {
      p.connected = true;
      p.left = false;
      if (name) p.name = name;
      if (avatar) p.avatar = cleanAvatar(avatar);
      socket.data.playerId = p.id;
    } else {
      if (!name) return socket.emit("err", "Please enter a name.");
      if (room.status !== "lobby") return socket.emit("err", "That game already started.");
      if (room.players.length >= MAX_PLAYERS) return socket.emit("err", `Room is full (${MAX_PLAYERS} players max).`);
      const taken = room.players.map((q) => q.color);
      const color = ASSIGN.find((c) => !taken.includes(c));
      const id = playerId || newId();
      socket.data.playerId = id;
      p = { id, name, color, left: false, connected: true, avatar: cleanAvatar(avatar) };
      room.players.push(p);
      room.log = `${name} joined.`;
    }
    room.v++;
    room.touched = Date.now();
    attach(socket, code);
    socket.emit("joined", { code, playerId: p.id });
    sendState(code);
  });

  socket.on("chat", ({ text, sticker } = {}) => {
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
    msg.n = p.name; msg.c = p.color; msg.a = p.avatar; msg.t = now;
    room.chat.push(msg);
    if (room.chat.length > CHAT_KEEP) room.chat.shift();
    room.v++;
    room.touched = now;
    sendState(room.code);
  });

  socket.on("settings", ({ tokens, team } = {}) => {
    const room = currentRoom();
    if (!room || room.status !== "lobby") return;
    if (room.host !== socket.data.playerId) return;
    let changed = false;
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

  socket.on("addBot", () => {
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

  socket.on("removeBot", () => {
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

  socket.on("start", () => {
    const room = currentRoom();
    if (!room || room.status !== "lobby") return;
    if (room.host !== socket.data.playerId) return;
    if (room.players.filter((p) => !p.left).length < 2) return socket.emit("err", "You need at least 2 players.");
    if (room.teamChoice && room.players.length === 3) addBotTo(room);
    if (room.teamChoice && room.players.length !== 4) return socket.emit("err", "Team mode needs 4 seats. Add bots to fill.");
    setupGame(room);
    if (room.teamMode) {
      const t0 = room.players.filter((p, s) => room.teamOf[s] === 0).map((p) => p.name).join(" & ");
      const t1 = room.players.filter((p, s) => room.teamOf[s] === 1).map((p) => p.name).join(" & ");
      room.log = `Teams drawn: ${t0} vs ${t1}. ${room.players[0].name} rolls first.`;
    } else {
      room.log = `${room.players[0].name} rolls first. Roll a 6 to bring a piece out.`;
    }
    room.v++;
    room.touched = Date.now();
    sendState(room.code);
    armTimer(room.code);
  });

  socket.on("roll", () => {
    const room = currentRoom();
    if (!room || room.status !== "playing" || room.phase !== "roll") return;
    const pl = room.players[room.turn];
    if (pl.id !== socket.data.playerId) return;
    performRoll(room);
  });

  socket.on("move", ({ i } = {}) => {
    const room = currentRoom();
    if (!room || room.status !== "playing" || room.phase !== "move") return;
    const pl = room.players[room.turn];
    if (pl.id !== socket.data.playerId) return;
    performMove(room, i);
  });



  socket.on("rematch", () => {
    const room = currentRoom();
    if (!room || room.status !== "over") return;
    if (room.host !== socket.data.playerId) return;
    if (room.players.filter((p) => !p.left).length < 2) return socket.emit("err", "Not enough players left for a rematch.");
    setupGame(room);
    room.log = `Rematch! ${room.players[0].name} rolls first.`;
    room.v++;
    room.touched = Date.now();
    sendState(room.code);
    armTimer(room.code);
  });

  function handleLeave() {
    const room = currentRoom();
    const p = me();
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
      if (room.host === p.id) room.host = (room.players.find((q) => !q.bot) || room.players[0]).id;
      room.log = `${p.name} left the lobby.`;
    } else {
      p.left = true;
      p.connected = false;
      dropVoice(room, p.id);
      room.log = `${p.name} left the game.`;
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

  socket.on("voice", ({ kind, to, data } = {}) => {
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

  socket.on("leave", () => handleLeave());

  socket.on("disconnect", () => {
    const room = currentRoom();
    const p = me();
    if (!room || !p) { detach(socket); return; }
    if (room.status === "lobby") {
      handleLeave();
      return;
    }
    p.connected = false;
    dropVoice(room, p.id);
    room.v++;
    detach(socket);
    sendState(room.code);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.touched > ROOM_IDLE_MS) deleteRoom(code);
  }
}, 10 * 60e3);

server.listen(PORT, () => {
  console.log(`Ludo Rooms running on port ${PORT}`);
});
