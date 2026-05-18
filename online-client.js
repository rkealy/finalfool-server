const els = {
  lobbyPanel: document.querySelector("#lobbyPanel"),
  roomPanel: document.querySelector("#roomPanel"),
  playerName: document.querySelector("#playerName"),
  roomCodeInput: document.querySelector("#roomCodeInput"),
  createRoomButton: document.querySelector("#createRoomButton"),
  joinRoomButton: document.querySelector("#joinRoomButton"),
  startGameButton: document.querySelector("#startGameButton"),
  onlineStatus: document.querySelector("#onlineStatus"),
  roomCodeLabel: document.querySelector("#roomCodeLabel"),
  roomPlayers: document.querySelector("#roomPlayers"),
  leaderboardPanel: document.querySelector("#leaderboardPanel"),
  leaderboard: document.querySelector("#leaderboard"),
  phaseLabel: document.querySelector("#phaseLabel"),
  turnLabel: document.querySelector("#turnLabel"),
  drawCount: document.querySelector("#drawCount"),
  pileCount: document.querySelector("#pileCount"),
  orderLabel: document.querySelector("#orderLabel"),
  drawBadge: document.querySelector("#drawBadge"),
  message: document.querySelector("#message"),
  discardPile: document.querySelector("#discardPile"),
  players: document.querySelector("#players"),
  playButton: document.querySelector("#playButton"),
  pickupButton: document.querySelector("#pickupButton"),
  doneSwapButton: document.querySelector("#doneSwapButton"),
  fireworks: document.querySelector("#fireworks"),
  interactiveAd: document.querySelector("#interactiveAd"),
  closeInteractiveAd: document.querySelector("#closeInteractiveAd"),
};

let socket;
let state = null;
let selected = [];
let swapSelection = null;
let interactiveAdDismissed = false;

function connect() {
  const nativeServer = window.FINAL_FOOL_ONLINE_SERVER || window.localStorage.getItem("finalFoolOnlineServer") || "";
  const host = nativeServer.replace(/^https?:\/\//, "").replace(/^wss?:\/\//, "") || window.location.host;
  if (!host) {
    setStatus("Online server URL is not configured for this native build.");
    return;
  }
  const protocol = nativeServer.startsWith("https://") || window.location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${host}/ws`);
  socket.addEventListener("open", () => setStatus("Connected. Create or join a room."));
  socket.addEventListener("close", () => {
    setStatus("Disconnected from online server.");
    window.setTimeout(connect, 1500);
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "state") {
      if (state?.phase === "gameover" && message.state.phase !== "gameover") interactiveAdDismissed = false;
      state = message.state;
      selected = [];
      swapSelection = null;
      render();
    }
    if (message.type === "error") setStatus(message.message);
  });
}

function send(type, payload = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    setStatus("Online server is not connected.");
    return;
  }
  socket.send(JSON.stringify({ type, ...payload }));
}

function setStatus(text) {
  els.onlineStatus.textContent = text;
}

function createRoom() {
  send("create", { name: playerName() });
}

function joinRoom() {
  send("join", { code: els.roomCodeInput.value.trim().toUpperCase(), name: playerName() });
}

function playerName() {
  return els.playerName.value.trim() || "Player";
}

function render() {
  if (!state) return;
  els.roomPanel.hidden = false;
  els.leaderboardPanel.hidden = false;
  els.roomPanel.classList.toggle("compact", state.phase !== "lobby");
  els.roomCodeLabel.textContent = state.roomCode;
  els.startGameButton.disabled = !state.isHost || state.phase !== "lobby" || state.players.length < 2;
  els.phaseLabel.textContent = phaseText();
  els.turnLabel.textContent = turnText();
  els.drawCount.textContent = state.deckCount;
  els.pileCount.textContent = state.pileCount;
  els.drawBadge.textContent = state.deckCount;
  els.orderLabel.textContent = state.direction === 1 ? "Left" : "Right";
  els.message.textContent = state.message;

  renderRoomPlayers();
  renderLeaderboard();
  renderDiscard();
  renderPlayers();
  renderControls();
  renderFireworks();
  renderAds();
}

function renderFireworks() {
  els.fireworks?.classList.toggle("active", Boolean(state.winnerId));
}

function renderAds() {
  const showInteractiveAd = state.phase === "gameover" && Boolean(state.winnerId) && !interactiveAdDismissed;
  els.interactiveAd?.classList.toggle("active", showInteractiveAd);
  els.interactiveAd?.setAttribute("aria-hidden", showInteractiveAd ? "false" : "true");
}

function phaseText() {
  if (state.phase === "lobby") return "Lobby";
  if (state.phase === "swap") return "Pre-game swap";
  if (state.phase === "play") return "In play";
  if (state.phase === "gameover") return "Game over";
  return "Online";
}

function turnText() {
  if (state.phase === "lobby") return "Waiting to deal";
  if (state.phase === "swap") return state.swapPlayerId === state.youId ? "Your swap" : `${playerNameById(state.swapPlayerId)} is swapping`;
  if (state.phase === "gameover") return "Round complete";
  if (state.awaitingNextTurn) return "Next player in 1 second";
  return state.turnPlayerId === state.youId ? "Your turn" : `${playerNameById(state.turnPlayerId)}'s turn`;
}

function renderRoomPlayers() {
  els.roomPlayers.innerHTML = "";
  if (state.phase === "lobby" && state.players.length < 2) {
    const waiting = document.createElement("div");
    waiting.className = "room-player waiting";
    waiting.innerHTML = "<span>Waiting for another player</span><span>2 min</span>";
    els.roomPlayers.append(waiting);
  }
  if (state.phase !== "lobby") {
    const summary = document.createElement("div");
    summary.className = "room-player compact-summary";
    summary.innerHTML = `<span>${state.players.length} players</span><span>${state.roomCode}</span>`;
    els.roomPlayers.append(summary);
    return;
  }
  for (const player of state.players) {
    const row = document.createElement("div");
    row.className = "room-player";
    row.innerHTML = `<span>${escapeHtml(player.name)}</span><span>${player.host ? "Host" : "Player"}</span>`;
    els.roomPlayers.append(row);
  }
}

function renderLeaderboard() {
  els.leaderboard.innerHTML = "";
  const rows = state.leaderboard || [];
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "leaderboard-empty";
    empty.textContent = "Completed multiplayer games will appear here.";
    els.leaderboard.append(empty);
    return;
  }

  const header = document.createElement("div");
  header.className = "leaderboard-row header";
  header.innerHTML = "<span>Name</span><span>Wins</span><span>Idiot</span>";
  els.leaderboard.append(header);

  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "leaderboard-row";
    item.innerHTML = `
      <span title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span>
      <strong>${row.wins}</strong>
      <strong>${row.idiot}</strong>
    `;
    els.leaderboard.append(item);
  }
}

function renderDiscard() {
  els.discardPile.innerHTML = "";
  if (!state.topPileCard) {
    const empty = document.createElement("div");
    empty.className = "card small";
    empty.textContent = "Pile";
    els.discardPile.append(empty);
    return;
  }
  els.discardPile.append(cardEl(state.topPileCard, true));
}

function renderPlayers() {
  els.players.innerHTML = "";
  for (const player of state.players) {
    const node = document.createElement("article");
    node.className = `player${isActivePlayer(player.id) ? " active" : ""}${player.out ? " out" : ""}`;
    node.innerHTML = `<div class="player-head"><h3>${escapeHtml(player.name)}</h3><span class="badge">${playerStatus(player)}</span></div>`;
    node.append(zoneLabel("Hand"));
    node.append(cardsRow(player, "hand"));
    node.append(zoneLabel("Face up"));
    node.append(cardsRow(player, "up"));
    node.append(zoneLabel("Face down"));
    node.append(cardsRow(player, "down"));
    els.players.append(node);
  }
}

function playerStatus(player) {
  if (player.out) return state.winnerId === player.id ? "Winner" : "Out";
  return `${player.cardCount} cards`;
}

function zoneLabel(text) {
  const label = document.createElement("p");
  label.className = "zone-label";
  label.textContent = text;
  return label;
}

function cardsRow(player, zone) {
  const row = document.createElement("div");
  row.className = "cards";
  const cards = player[zone] || [];
  cards.forEach((card, index) => {
    const element = card ? cardEl(card) : backEl();
    if (isSelectable(player, zone, card, index)) {
      element.classList.add("playable");
      element.addEventListener("click", () => selectCard(zone, index));
    } else if (player.id === state.youId && card && zone === activeZone(player)) {
      element.classList.add("disabled");
    }
    if (isSelected(zone, index)) element.classList.add("selected");
    if (isSwapSelected(zone, index)) element.classList.add("selected");
    row.append(element);
  });
  return row;
}

function isActivePlayer(playerId) {
  return (state.phase === "swap" && state.swapPlayerId === playerId) || (state.phase === "play" && state.turnPlayerId === playerId);
}

function isSelectable(player, zone, card) {
  if (player.id !== state.youId || state.awaitingNextTurn) return false;
  if (state.phase === "swap") return player.id === state.swapPlayerId && (zone === "hand" || zone === "up");
  if (state.phase !== "play" || player.id !== state.turnPlayerId) return false;
  if (zone !== activeZone(player)) return false;
  if (zone === "down") return true;
  return canPlay(card);
}

function selectCard(zone, index) {
  if (state.phase === "swap") {
    selectSwap(zone, index);
    return;
  }
  const you = state.players.find((player) => player.id === state.youId);
  const card = you[zone][index];
  const existing = selected.findIndex((item) => item.zone === zone && item.index === index);
  if (existing >= 0) {
    selected.splice(existing, 1);
  } else if (zone === "down") {
    selected = [{ zone, index }];
  } else {
    const sameSet = selected.length && selected[0].zone === zone && you[zone][selected[0].index]?.rank === card.rank;
    selected = sameSet ? [...selected, { zone, index }] : [{ zone, index }];
  }
  selected.sort((a, b) => a.index - b.index);
  render();
}

function selectSwap(zone, index) {
  if (!swapSelection) {
    swapSelection = { zone, index };
    render();
    return;
  }
  const first = swapSelection;
  if (first.zone === zone && first.index === index) {
    swapSelection = null;
    render();
    return;
  }
  if (first.zone !== zone) send("swap", { first, second: { zone, index } });
}

function playSelected() {
  if (!selected.length) return;
  send("play", { zone: selected[0].zone, indices: selected.map((item) => item.index) });
}

function renderControls() {
  const you = state.players.find((player) => player.id === state.youId);
  const isYourTurn = state.phase === "play" && state.turnPlayerId === state.youId && !state.awaitingNextTurn;
  const legal = you ? legalCards(you) : [];
  els.playButton.textContent = selected.length > 1 ? `Play ${selected.length} Selected` : "Play Selected";
  els.playButton.disabled = !isYourTurn || !selected.length;
  els.pickupButton.disabled = !isYourTurn || activeZone(you) === "down" || !state.pileCount || legal.length > 0;
  els.doneSwapButton.disabled = state.phase !== "swap" || state.swapPlayerId !== state.youId;
}

function canPlay(card) {
  if (!card) return false;
  if (state.openingRank) return card.rank === state.openingRank;
  if (card.wild) return true;
  if (state.requirementMode === "maximum") return card.value <= state.lastRequirement;
  return card.value >= state.lastRequirement;
}

function legalCards(player) {
  if (!player) return [];
  const zone = activeZone(player);
  if (zone === "down") return player.down;
  return player[zone].filter(canPlay);
}

function activeZone(player) {
  if (!player) return "hand";
  if (player.hand.length) return "hand";
  if (player.up.length) return "up";
  return "down";
}

function cardEl(card, small = false) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = `card${card.red ? " red" : ""}${card.joker ? " joker" : ""}${small ? " small" : ""}`;
  node.dataset.rank = card.rank;
  node.dataset.suit = card.suit;
  node.textContent = card.joker ? "J" : card.rank;
  return node;
}

function backEl() {
  const node = document.createElement("button");
  node.type = "button";
  node.className = "card back";
  return node;
}

function isSelected(zone, index) {
  return selected.some((item) => item.zone === zone && item.index === index);
}

function isSwapSelected(zone, index) {
  return swapSelection?.zone === zone && swapSelection?.index === index;
}

function playerNameById(id) {
  return state.players.find((player) => player.id === id)?.name || "Player";
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

els.createRoomButton.addEventListener("click", createRoom);
els.joinRoomButton.addEventListener("click", joinRoom);
els.startGameButton.addEventListener("click", () => send("start"));
els.playButton.addEventListener("click", playSelected);
els.pickupButton.addEventListener("click", () => send("pickup"));
els.doneSwapButton.addEventListener("click", () => send("readySwap"));
els.closeInteractiveAd?.addEventListener("click", () => {
  interactiveAdDismissed = true;
  renderAds();
});

connect();
