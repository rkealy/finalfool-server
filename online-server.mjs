import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { extname, join, normalize, resolve } from "node:path";
import { readFile } from "node:fs/promises";

const root = resolve(".");
const port = Number(process.env.PORT || 4174);
const TURN_DELAY_MS = 1000;
const WILD_RANKS = new Set(["2", "5", "10"]);
const SUITS = [
  { symbol: "♠", red: false },
  { symbol: "♥", red: true },
  { symbol: "♦", red: true },
  { symbol: "♣", red: false },
];
const RANKS = [
  ["A", 14],
  ["K", 13],
  ["Q", 12],
  ["J", 11],
  ["10", 10],
  ["9", 9],
  ["8", 8],
  ["7", 7],
  ["6", 6],
  ["5", 5],
  ["4", 4],
  ["3", 3],
  ["2", 2],
];
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};
const rooms = new Map();
const clients = new Map();
const leaderboard = new Map();

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const relativePath = url.pathname === "/" ? "mobile-online.html" : url.pathname.slice(1);
  const filePath = normalize(join(root, relativePath));
  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  try {
    const file = await readFile(filePath);
    response.writeHead(200, { "Content-Type": types[extname(filePath)] || "application/octet-stream" });
    response.end(file);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
});

server.on("upgrade", (request, socket) => {
  if (request.url !== "/ws") {
    socket.destroy();
    return;
  }
  const key = request.headers["sec-websocket-key"];
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const client = { id: randomUUID(), socket, roomCode: null, playerId: null, buffer: Buffer.alloc(0) };
  clients.set(client.id, client);
  socket.on("data", (chunk) => readFrames(client, chunk));
  socket.on("close", () => disconnect(client));
  socket.on("error", () => disconnect(client));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Final Fool online server running at http://127.0.0.1:${port}/mobile-online.html`);
});

function readFrames(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);
  while (client.buffer.length >= 2) {
    const firstByte = client.buffer[0];
    const second = client.buffer[1];
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (client.buffer.length < 4) return;
      length = client.buffer.readUInt16BE(2);
      offset = 4;
    }
    if (client.buffer.length < offset + 4 + length) return;
    const mask = client.buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = client.buffer.subarray(offset, offset + length);
    const data = Buffer.alloc(length);
    for (let i = 0; i < length; i++) data[i] = payload[i] ^ mask[i % 4];
    client.buffer = client.buffer.subarray(offset + length);
    const opcode = firstByte & 0x0f;
    if (opcode === 8) return disconnect(client);
    try {
      handleMessage(client, JSON.parse(data.toString("utf8")));
    } catch {
      send(client, { type: "error", message: "Invalid message." });
    }
  }
}

function send(client, value) {
  if (client.socket.destroyed) return;
  const payload = Buffer.from(JSON.stringify(value));
  const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
  client.socket.write(Buffer.concat([header, payload]));
}

function handleMessage(client, message) {
  if (message.type === "create") return createRoom(client, message.name);
  if (message.type === "join") return joinRoom(client, message.code, message.name);
  const room = rooms.get(client.roomCode);
  if (!room) return send(client, { type: "error", message: "Join a room first." });
  if (message.type === "start") return startGame(room, client);
  if (message.type === "swap") return swapCards(room, client, message.first, message.second);
  if (message.type === "readySwap") return readySwap(room, client);
  if (message.type === "play") return playCards(room, client, message.zone, message.indices);
  if (message.type === "pickup") return pickupPile(room, client);
}

function createRoom(client, name) {
  let code = "";
  do code = Math.random().toString(36).slice(2, 8).toUpperCase();
  while (rooms.has(code));
  const room = { code, hostId: client.id, players: [], game: null, timer: null };
  rooms.set(code, room);
  joinRoom(client, code, name);
}

function joinRoom(client, code, name) {
  const room = rooms.get(String(code || "").toUpperCase());
  if (!room) return send(client, { type: "error", message: "Room not found." });
  if (room.players.length >= 5) return send(client, { type: "error", message: "Room is full." });
  if (room.game?.phase && room.game.phase !== "lobby") return send(client, { type: "error", message: "Game already started." });
  client.roomCode = room.code;
  client.playerId = randomUUID();
  room.players.push({ id: client.playerId, clientId: client.id, name: cleanName(name), hand: [], up: [], down: [], out: false, ready: false });
  room.game = room.game || freshGame();
  broadcast(room);
}

function disconnect(client) {
  clients.delete(client.id);
  const room = rooms.get(client.roomCode);
  if (!room) return;
  room.players = room.players.filter((player) => player.clientId !== client.id);
  if (!room.players.length) {
    if (room.timer) clearTimeout(room.timer);
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === client.id) room.hostId = room.players[0].clientId;
  broadcast(room);
}

function freshGame() {
  return {
    phase: "lobby",
    deck: [],
    pile: [],
    turnPlayerId: null,
    swapPlayerId: null,
    direction: 1,
    lastRequirement: 0,
    requirementMode: "minimum",
    openingRank: null,
    awaitingNextTurn: false,
    winners: [],
    idiot: null,
    message: "Waiting for players.",
  };
}

function startGame(room, client) {
  if (client.id !== room.hostId) return;
  if (room.players.length < 2) {
    send(client, { type: "error", message: "Online multiplayer needs at least 2 players." });
    return;
  }
  const game = freshGame();
  game.phase = "swap";
  game.deck = buildDeck();
  room.game = game;
  for (const player of room.players) {
    player.hand = [];
    player.up = [];
    player.down = [];
    player.out = false;
    player.ready = false;
  }
  for (const zone of ["down", "up", "hand"]) {
    for (let round = 0; round < 3; round++) {
      for (const player of room.players) player[zone].push(game.deck.pop());
    }
  }
  for (const player of room.players) sortCards(player.hand);
  game.swapPlayerId = room.players[0].id;
  game.message = `${room.players[0].name}: swap hand cards with face-up cards, then press Ready.`;
  broadcast(room);
}

function swapCards(room, client, first, second) {
  const game = room.game;
  const player = room.players.find((item) => item.clientId === client.id);
  if (!player || game.phase !== "swap" || game.swapPlayerId !== player.id) return;
  if (!["hand", "up"].includes(first?.zone) || !["hand", "up"].includes(second?.zone) || first.zone === second.zone) return;
  const a = player[first.zone][first.index];
  const b = player[second.zone][second.index];
  if (!a || !b) return;
  player[first.zone][first.index] = b;
  player[second.zone][second.index] = a;
  sortCards(player.hand);
  game.message = `${player.name}: cards swapped.`;
  broadcast(room);
}

function readySwap(room, client) {
  const game = room.game;
  const player = room.players.find((item) => item.clientId === client.id);
  if (!player || game.phase !== "swap" || game.swapPlayerId !== player.id) return;
  player.ready = true;
  const next = room.players.find((item) => !item.ready);
  if (next) {
    game.swapPlayerId = next.id;
    game.message = `${next.name}: swap hand cards with face-up cards, then press Ready.`;
  } else {
    finishSwap(room);
  }
  broadcast(room);
}

function finishSwap(room) {
  const game = room.game;
  const first = findStartingPlayer(room);
  game.phase = "play";
  game.turnPlayerId = first.player.id;
  game.swapPlayerId = null;
  game.openingRank = first.card.rank;
  game.message = `${first.player.name} starts and must play ${first.card.rank}.`;
}

function findStartingPlayer(room) {
  const contenders = room.players
    .map((player) => ({ player, card: player.hand.filter((card) => !card.wild).sort((a, b) => a.value - b.value)[0] }))
    .filter((item) => item.card)
    .sort((a, b) => a.card.value - b.card.value);
  if (!contenders.length) return { player: room.players[0], card: room.players[0].hand[0] };
  const lowest = contenders[0].card.value;
  const tied = contenders.filter((item) => item.card.value === lowest);
  if (tied.length === 1) return tied[0];
  return tied[Math.floor(Math.random() * tied.length)];
}

function playCards(room, client, zone, indices) {
  const game = room.game;
  const player = room.players.find((item) => item.clientId === client.id);
  if (!player || game.phase !== "play" || game.awaitingNextTurn || game.turnPlayerId !== player.id || zone !== activeZone(player)) return;
  const unique = [...new Set(indices)].sort((a, b) => b - a);
  const cards = unique.map((index) => player[zone][index]).filter(Boolean);
  if (!cards.length) return;
  if (zone !== "down" && !cards.every((card) => card.rank === cards[0].rank && canPlay(game, card))) return;
  const first = cards[0];
  if (zone === "down" && !canPlay(game, first)) {
    player[zone].splice(unique[0], 1);
    game.pile.push(first);
    player.hand.push(...game.pile);
    sortCards(player.hand);
    game.pile = [];
    game.lastRequirement = 0;
    game.requirementMode = "minimum";
    game.openingRank = null;
    game.message = `${player.name} flipped ${labelCard(first)} and picked up the pile.`;
    delayNextTurn(room);
    return;
  }
  for (const index of unique) {
    game.pile.push(player[zone][index]);
    player[zone].splice(index, 1);
  }
  applyCardEffect(game, cards, player);
  game.openingRank = null;
  drawUp(game, player);
  checkPlayerOut(game, player);
  if (isGameOver(room)) finishGame(room);
  else delayNextTurn(room);
}

function pickupPile(room, client) {
  const game = room.game;
  const player = room.players.find((item) => item.clientId === client.id);
  if (!player || game.phase !== "play" || game.awaitingNextTurn || game.turnPlayerId !== player.id || activeZone(player) === "down") return;
  const legal = player[activeZone(player)].filter((card) => canPlay(game, card));
  if (legal.length || !game.pile.length) return;
  player.hand.push(...game.pile);
  sortCards(player.hand);
  game.pile = [];
  game.lastRequirement = 0;
  game.requirementMode = "minimum";
  game.message = `${player.name} picked up the discard pile.`;
  delayNextTurn(room);
}

function delayNextTurn(room) {
  const game = room.game;
  game.awaitingNextTurn = true;
  broadcast(room);
  if (room.timer) clearTimeout(room.timer);
  room.timer = setTimeout(() => {
    game.awaitingNextTurn = false;
    advanceTurn(room);
    broadcast(room);
  }, TURN_DELAY_MS);
}

function advanceTurn(room) {
  const active = room.players.filter((player) => !player.out);
  if (active.length <= 1) return;
  const currentIndex = room.players.findIndex((player) => player.id === room.game.turnPlayerId);
  let next = currentIndex;
  do next = (next + room.game.direction + room.players.length) % room.players.length;
  while (room.players[next].out);
  room.game.turnPlayerId = room.players[next].id;
}

function applyCardEffect(game, cards, player) {
  const card = cards[0];
  const played = cards.length === 1 ? labelCard(card) : `${cards.length} ${card.rank}s`;
  if (card.rank === "10") {
    const burned = game.pile.length;
    game.pile = [];
    game.lastRequirement = 0;
    game.requirementMode = "minimum";
    game.message = `${player.name} played ${played} and burned ${burned} cards.`;
  } else if (card.rank === "2") {
    game.lastRequirement = 0;
    game.requirementMode = "minimum";
    game.message = `${player.name} played ${played}. Anything can be played next.`;
  } else if (card.rank === "5") {
    game.lastRequirement = 5;
    game.requirementMode = "maximum";
    game.message = `${player.name} played ${played}. Next card must be 5 or less, or wild.`;
  } else if (card.joker) {
    game.direction *= -1;
    game.lastRequirement = 0;
    game.requirementMode = "minimum";
    game.message = `${player.name} played ${played} and reversed the order.`;
  } else {
    game.lastRequirement = card.value;
    game.requirementMode = "minimum";
    game.message = `${player.name} played ${played}.`;
  }
}

function checkPlayerOut(game, player) {
  if (!player.out && !player.hand.length && !player.up.length && !player.down.length) {
    player.out = true;
    game.winners.push(player.id);
    game.message = `${player.name} is out${game.winners.length === 1 ? " and wins" : ""}.`;
  }
}

function finishGame(room) {
  const game = room.game;
  const remaining = room.players.find((player) => !player.out);
  game.idiot = remaining?.id || null;
  game.phase = "gameover";
  recordGameResult(room);
  game.message = remaining
    ? `${room.players.find((player) => player.id === game.winners[0])?.name || "First player out"} wins. ${remaining.name} is the idiot.`
    : `${room.players.find((player) => player.id === game.winners[0])?.name || "The first player out"} wins.`;
  broadcast(room);
}

function isGameOver(room) {
  if (room.players.length === 1) return room.players[0].out;
  return room.players.filter((player) => !player.out).length <= 1;
}

function broadcast(room) {
  for (const player of room.players) {
    const client = clients.get(player.clientId);
    if (client) send(client, { type: "state", state: publicState(room, player) });
  }
}

function publicState(room, viewer) {
  const game = room.game || freshGame();
  return {
    roomCode: room.code,
    youId: viewer.id,
    isHost: viewer.clientId === room.hostId,
    phase: game.phase,
    deckCount: game.deck.length,
    pileCount: game.pile.length,
    topPileCard: game.pile.at(-1) || null,
    direction: game.direction,
    turnPlayerId: game.turnPlayerId,
    swapPlayerId: game.swapPlayerId,
    awaitingNextTurn: game.awaitingNextTurn,
    lastRequirement: game.lastRequirement,
    requirementMode: game.requirementMode,
    openingRank: game.openingRank,
    message: game.message,
    winnerId: game.winners[0] || null,
    idiotId: game.idiot,
    leaderboard: leaderboardRows(),
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      host: player.clientId === room.hostId,
      out: player.out,
      cardCount: player.hand.length + player.up.length + player.down.length,
      hand: player.id === viewer.id ? player.hand : Array.from({ length: player.hand.length }, () => null),
      up: player.up,
      down: Array.from({ length: player.down.length }, () => null),
    })),
  };
}

function recordGameResult(room) {
  const game = room.game;
  const winner = room.players.find((player) => player.id === game.winners[0]);
  const idiot = room.players.find((player) => player.id === game.idiot);
  if (winner) addLeaderboardResult(winner.name, "wins");
  if (idiot) addLeaderboardResult(idiot.name, "idiot");
}

function addLeaderboardResult(name, key) {
  const clean = cleanName(name);
  const entry = leaderboard.get(clean) || { name: clean, wins: 0, idiot: 0 };
  entry[key] += 1;
  leaderboard.set(clean, entry);
}

function leaderboardRows() {
  return [...leaderboard.values()]
    .sort((a, b) => b.wins - a.wins || a.idiot - b.idiot || a.name.localeCompare(b.name))
    .slice(0, 20);
}

function buildDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const [rank, value] of RANKS) deck.push({ id: `${rank}${suit.symbol}`, rank, value, suit: suit.symbol, red: suit.red, wild: WILD_RANKS.has(rank) });
  }
  deck.push({ id: "JokerA", rank: "Joker", value: 0, suit: "★", red: false, wild: true, joker: true });
  deck.push({ id: "JokerB", rank: "Joker", value: 0, suit: "★", red: true, wild: true, joker: true });
  return shuffle(deck);
}

function shuffle(cards) {
  const copy = [...cards];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function sortCards(cards) {
  cards.sort((a, b) => cardPlayValue(a) - cardPlayValue(b) || a.id.localeCompare(b.id));
}

function cardPlayValue(card) {
  if (card.joker) return 17;
  if (card.rank === "10") return 16;
  if (card.rank === "2") return 15;
  if (card.rank === "5") return 5;
  return card.value;
}

function canPlay(game, card) {
  if (game.openingRank) return card.rank === game.openingRank;
  if (card.wild) return true;
  if (game.requirementMode === "maximum") return card.value <= game.lastRequirement;
  return card.value >= game.lastRequirement;
}

function activeZone(player) {
  if (player.hand.length) return "hand";
  if (player.up.length) return "up";
  return "down";
}

function drawUp(game, player) {
  while (player.hand.length < 3 && game.deck.length) player.hand.push(game.deck.pop());
  sortCards(player.hand);
}

function labelCard(card) {
  return card.joker ? "Joker" : `${card.rank}${card.suit}`;
}

function cleanName(name) {
  return String(name || "Player").trim().slice(0, 18) || "Player";
}
