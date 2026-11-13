'use strict';

var createTransport = require('./transport').createTransport;
var ConnectionStatus = require('./connection-status');
var render = require('./render');
var ChatClient = require('./chat-client');
var Canvas = require('./canvas');
var global = require('./global');
var createSessionStore = require('./session-store').createSessionStore;
var createRoomStore = require('./room-store').createRoomStore;
var AppUI = require('./app-ui');
var formatAuthError = require('./ui-format').formatAuthError;
var formatRoomError = require('./ui-format').formatRoomError;

var sessionStore = createSessionStore();
var roomStore = createRoomStore();
var connectionStatus = new ConnectionStatus(document.getElementById('connectionStatus'));

var socket = null;
var ui = null;
var pendingQuickPlay = false;
var quickPlayActive = false;
var roomGameActive = false;
var creatingRoom = false;
var replacingSocket = false;

var debug = function (args) {
    if (console && console.log) {
        console.log(args);
    }
};

if (/Android|webOS|iPhone|iPad|iPod|BlackBerry/i.test(navigator.userAgent)) {
    global.mobile = true;
}

// TODO: Break out into GameControls.

var playerConfig = {
    border: 6,
    textColor: '#FFFFFF',
    textBorder: '#000000',
    textBorderSize: 3,
    defaultSize: 30
};

var player = {
    id: -1,
    x: global.screen.width / 2,
    y: global.screen.height / 2,
    screenWidth: global.screen.width,
    screenHeight: global.screen.height,
    target: { x: global.screen.width / 2, y: global.screen.height / 2 }
};
global.player = player;

var foods = [];
var viruses = [];
var fireFood = [];
var users = [];
var leaderboard = [];
var target = { x: player.x, y: player.y };
global.target = target;

window.canvas = new Canvas();
window.chat = new ChatClient();

var c = window.canvas.cv;
var graph = c.getContext('2d');

// Settings checkboxes live on the auth screen and only affect local drawing.
var visibleBorderSetting = document.getElementById('visBord');
visibleBorderSetting.onchange = function () {
    window.chat.toggleBorder();
};

var showMassSetting = document.getElementById('showMass');
showMassSetting.onchange = function () {
    window.chat.toggleMass();
};

var continuitySetting = document.getElementById('continuity');
continuitySetting.onchange = function () {
    window.chat.toggleContinuity();
};

var roundFoodSetting = document.getElementById('roundFood');
roundFoodSetting.onchange = function () {
    window.chat.toggleRoundFood();
};

$('#feed').click(function () {
    if (socket) {
        socket.emit('1');
        window.canvas.reenviar = false;
    }
});

$('#split').click(function () {
    if (socket) {
        socket.emit('2');
        window.canvas.reenviar = false;
    }
});

function openConnection(type) {
    connectionStatus.connecting();
    socket = createTransport({
        query: 'type=' + type,
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000
    });

    global.socket = socket;
    window.canvas.socket = socket;
    window.chat.socket = socket;
    setupSocket(socket);
    window.chat.registerFunctions();
    return socket;
}

function ensureConnection() {
    if (socket) {
        return socket;
    }

    // The auth/lobby/room flows all need the player handlers.
    return openConnection('player');
}

function prepareGameSession() {
    if (!socket) {
        return;
    }
    global.socket = socket;
    window.canvas.socket = socket;
    window.chat.socket = socket;
    window.chat.player = global.player;
    if (!global.animLoopHandle) {
        animloop();
    }
}

// Checks if the nick chosen contains valid alphanumeric characters (and underscores).
function validNick(name) {
    return /^\w+$/.test(name) && name.length <= 25;
}

function startQuickPlay(type, name) {
    var mode = type === 'spectator' ? 'spectator' : 'player';
    var playerName = String(name || '').replace(/(<([^>]+)>)/ig, '').substring(0, 25);

    if (!validNick(playerName)) {
        ui.setAuthError('Names may only contain letters, numbers and underscores (max 25).');
        return;
    }

    sessionStore.setGuestName(playerName);
    global.playerName = playerName;
    global.playerType = mode;
    global.roomGame = false;
    global.gameStart = false;
    global.kicked = false;

    quickPlayActive = true;
    roomGameActive = false;
    pendingQuickPlay = mode === 'player';

    if (mode === 'spectator') {
        startSpectatorSession();
        return;
    }

    ensureConnection();
    prepareGameSession();
    ui.showGame(null, mode);

    // Transports queue events until the connection is ready, so this is safe
    // even when quick play is clicked before the socket finishes connecting.
    socket.emit('respawn');
}

function startSpectatorSession() {
    // Spectators use the server's `type=spectator` handlers, which send a
    // welcome immediately and never create a playable cell. The player socket
    // used by auth/lobby cannot be reused for that, so start a fresh one.
    if (socket) {
        replacingSocket = true;
        if (typeof socket.close === 'function') {
            socket.close();
        }
        socket = null;
        replacingSocket = false;
    }

    openConnection('spectator');
    prepareGameSession();
    ui.showGame(null, 'spectator');
}

function showLobby() {
    quickPlayActive = false;
    pendingQuickPlay = false;
    roomGameActive = false;
    global.roomGame = false;
    global.gameStart = false;
    roomStore.setRoomsLoading(true);
    ui.setIdentity(identityLabel());
    ui.showLobby();
    ensureConnection().emit('listRooms');
}

function identityLabel() {
    if (sessionStore.account) {
        return 'Signed in as ' + sessionStore.account.username;
    }
    return 'Playing as guest' + (sessionStore.guestName ? ' · ' + sessionStore.guestName : '');
}

function joinRoom(payload) {
    if (!payload || (!payload.id && !payload.code)) {
        return;
    }
    ensureConnection();
    ensureGuestIdentity();
    ui.setLobbyError('');
    ui.setRoomError('');
    ui.setBusy('lobby', true);
    ensureConnection().emit('joinRoom', payload);
}

function ensureGuestIdentity() {
    if (!socket || sessionStore.account) {
        return;
    }

    socket.emit('gotit', {
        name: sessionStore.guestName || 'Guest',
        screenWidth: window.innerWidth,
        screenHeight: window.innerHeight,
        target: window.canvas.target
    });
}

function leaveRoom() {
    if (!roomStore.room) {
        showLobby();
        return;
    }
    ensureConnection().emit('leaveRoom');
}

function returnToLobby() {
    if (!roomStore.room) {
        return;
    }
    ui.setReturningToLobby();
    ensureConnection().emit('returnToLobby', { id: roomStore.room.id });
}

function beginRoomGame(snapshot) {
    if (!roomStore.room || !snapshot) {
        return;
    }
    if (roomGameActive && ui.screen === 'game' && global.roomGame) {
        return;
    }

    quickPlayActive = false;
    pendingQuickPlay = false;
    roomGameActive = true;
    global.roomGame = true;
    global.playerType = roomStore.isSpectator ? 'spectator' : 'player';
    global.playerName = roomStore.viewerName || sessionStore.displayName;
    global.disconnected = false;
    global.kicked = false;

    if (snapshot.map) {
        global.game.width = snapshot.map.width;
        global.game.height = snapshot.map.height;
    }

    foods = [];
    viruses = [];
    fireFood = [];
    users = [];
    leaderboard = [];

    ui.showGame(roomStore.room, roomStore.role);
    prepareGameSession();

    if (roomStore.isSpectator) {
        global.screen.width = global.game.width;
        global.screen.height = global.game.height;
        player.x = global.game.width / 2;
        player.y = global.game.height / 2;
        player.screenWidth = global.screen.width;
        player.screenHeight = global.screen.height;
        c.width = global.screen.width;
        c.height = global.screen.height;
    } else {
        global.screen.width = window.innerWidth;
        global.screen.height = window.innerHeight;
        resize();
    }

    global.gameStart = true;
    window.chat.addSystemLine(
        roomStore.isSpectator ? 'Spectating the match.' : 'Match started!'
    );

    if (global.mobile) {
        var chatbox = document.getElementById('chatbox');
        if (chatbox && chatbox.parentNode) {
            chatbox.parentNode.removeChild(chatbox);
        }
    }

    c.focus();
}

function endRoomGame(result) {
    global.gameStart = false;
    roomGameActive = false;
    ui.showGameOver(result, {
        isOwner: roomStore.isOwner,
        inRoom: Boolean(roomStore.room)
    });
}

function handleDisconnect() {
    if (replacingSocket) {
        return;
    }

    global.gameStart = false;
    global.disconnected = true;

    if (quickPlayActive) {
        pendingQuickPlay = true;
    }

    // `kick` already rendered the specific message and closed the socket.
    if (global.kicked) {
        return;
    }
    if (global.serverShuttingDown) {
        connectionStatus.shutdown();
        return;
    }

    connectionStatus.disconnected();
}

function handleConnectError() {
    global.disconnected = true;
    if (global.serverShuttingDown) {
        connectionStatus.shutdown();
        return;
    }
    connectionStatus.offline('Cannot reach the server. Retrying…');
}

function handleServerShutdown() {
    global.serverShuttingDown = true;
    global.gameStart = false;
    global.disconnected = true;
    connectionStatus.shutdown();

    if (socket && typeof socket.close === 'function') {
        socket.close();
    }
}

function handleConnect() {
    global.disconnected = false;
    global.serverShuttingDown = false;
    global.kicked = false;
    connectionStatus.connected();

    if (sessionStore.token) {
        socket.emit('auth', { token: sessionStore.token });
    } else if (roomStore.room) {
        // Guest reconnects get a new server identity, so rejoin explicitly.
        ensureGuestIdentity();
        var base = { id: roomStore.room.id };
        if (roomStore.inGame) {
            base.asSpectator = true;
        }
        socket.emit('joinRoom', base);
        return;
    }

    if (pendingQuickPlay) {
        socket.emit('respawn');
    } else if (roomGameActive && roomStore.room) {
        socket.emit('getGameState');
    }
}

function handleAuthOk(payload) {
    if (!payload || !payload.account || !payload.token) {
        return;
    }

    sessionStore.setSession({
        token: payload.token,
        account: payload.account
    });
    roomStore.setAccount(payload.account);
    ui.setBusy('auth', false);
    ui.setAuthError('');
    ui.setIdentity(identityLabel());

    if (!roomStore.room && !quickPlayActive) {
        showLobby();
    }
}

function handleAuthError(payload) {
    const code = payload && payload.code;
    const fatal = code === 'invalid_session' ||
        code === 'session_expired' ||
        code === 'session_replaced' ||
        code === 'duplicate_login';

    sessionStore.clearSession();
    roomStore.clearAccount();

    if (fatal) {
        roomStore.resetRoom();
        quickPlayActive = false;
        pendingQuickPlay = false;
        roomGameActive = false;
        global.roomGame = false;
        global.gameStart = false;
    }

    ui.setBusy('auth', false);
    ui.setBusy('lobby', false);
    ui.setAuthError(formatAuthError(payload));

    if (fatal || !roomStore.room) {
        ui.showAuth(formatAuthError(payload));
    }
}

function handleWelcome(playerSettings, gameSizes) {
    if (!pendingQuickPlay && !quickPlayActive) {
        return;
    }

    pendingQuickPlay = false;

    player = Object.assign({}, playerSettings || {}, {
        name: global.playerName,
        screenWidth: global.screen.width,
        screenHeight: global.screen.height,
        target: window.canvas.target
    });
    global.player = player;
    window.chat.player = player;
    socket.emit('gotit', player);
    global.gameStart = true;
    global.disconnected = false;
    global.serverShuttingDown = false;
    connectionStatus.connected();
    window.chat.addSystemLine('Connected to the game!');
    window.chat.addSystemLine('Type <b>-help</b> for a list of commands.');

    if (global.mobile) {
        var chatbox = document.getElementById('chatbox');
        if (chatbox && chatbox.parentNode) {
            chatbox.parentNode.removeChild(chatbox);
        }
    }

    c.focus();
    if (gameSizes) {
        global.game.width = gameSizes.width;
        global.game.height = gameSizes.height;
    }
    resize();
    ui.showGame(null, global.playerType);
}

function handleRoomSnapshot(snapshot) {
    ui.setBusy('lobby', false);
    ui.setRoomError('');

    roomStore.enterRoom(snapshot);
    ui.setIdentity(identityLabel());

    if (snapshot.game && snapshot.game.state === 'running') {
        beginRoomGame(snapshot.game);
        return;
    }

    ui.showRoom();
}

function handleGameState(snapshot) {
    if (!snapshot || !roomStore.room) {
        return;
    }

    roomStore.applyGameState(snapshot);

    if (snapshot.state === 'running') {
        if (!roomGameActive) {
            beginRoomGame(snapshot);
        }
        return;
    }

    if (snapshot.state === 'lobby') {
        roomGameActive = false;
        global.roomGame = false;
        global.gameStart = false;
        ui.resetReturnToLobby();
        ui.showRoom();
        return;
    }

    if (snapshot.state === 'countdown') {
        if (ui.screen === 'room') {
            ui.renderRoom();
        } else {
            ui.showRoom();
        }
        return;
    }

    if (snapshot.state === 'finished') {
        ui.renderRoom();
    }
}

function handleRoomError(payload) {
    var message = formatRoomError(payload);
    creatingRoom = false;
    ui.setBusy('lobby', false);
    ui.setBusy('room', false);

    if (ui.screen === 'lobby' || (!roomStore.room && ui.screen !== 'game')) {
        ui.setLobbyError(message);
        return;
    }

    ui.setRoomError(message);
}

// socket stuff.
function setupSocket(socket) {
    // Handle ping.
    socket.on('pongcheck', function () {
        var latency = Date.now() - global.startPingTime;
        debug('Latency: ' + latency + 'ms');
        window.chat.addSystemLine('Ping: ' + latency + 'ms');
    });

    // Handle the connection lifecycle.
    socket.on('connect', handleConnect);
    socket.on('connect_error', handleConnectError);
    socket.on('disconnect', handleDisconnect);
    socket.on('serverShutdown', handleServerShutdown);

    // Transports report reconnect attempts directly on the transport.
    socket.on('reconnecting', function (attempt, delay) {
        global.disconnected = true;
        connectionStatus.reconnecting(attempt, delay);
    });
    socket.on('reconnect_failed', function () {
        global.disconnected = true;
        connectionStatus.offline('Could not reconnect. Refresh to try again.');
    });

    // Accounts.
    socket.on('authOk', handleAuthOk);
    socket.on('authError', handleAuthError);
    socket.on('loggedOut', function () {
        sessionStore.clearSession();
        roomStore.clearAccount();
        roomStore.resetRoom();
        quickPlayActive = false;
        roomGameActive = false;
        global.roomGame = false;
        global.gameStart = false;
        ui.showAuth('Signed out.');
    });

    // Lobby and rooms.
    socket.on('roomList', function (payload) {
        roomStore.setRoomList(payload && payload.rooms);
        if (ui.screen === 'lobby') {
            ui.renderRoomList();
        }
    });

    socket.on('roomCreated', function (payload) {
        if (!payload || !payload.room) {
            return;
        }

        roomStore.upsertRoom(payload.room);
        ui.setBusy('lobby', false);

        if (ui.screen === 'lobby') {
            ui.renderRoomList();
            var nameInput = document.getElementById('createRoomName');
            if (nameInput) {
                nameInput.value = '';
            }
        }

        if (creatingRoom) {
            creatingRoom = false;
            joinRoom({ id: payload.room.id });
        }
    });

    socket.on('roomUpdated', function (payload) {
        if (!payload || !payload.room) {
            return;
        }

        roomStore.applyRoomUpdated(payload.room);

        if (ui.screen === 'room') {
            ui.renderRoom();
        } else if (ui.screen === 'lobby') {
            ui.renderRoomList();
        }
    });

    socket.on('roomRemoved', function (summary) {
        var wasCurrent = roomStore.applyRoomRemoved(summary);

        if (wasCurrent) {
            showLobby();
            ui.setLobbyError('That room was closed.');
            return;
        }

        if (ui.screen === 'lobby') {
            ui.renderRoomList();
        }
    });

    socket.on('roomSnapshot', handleRoomSnapshot);

    socket.on('roomLeft', function () {
        roomStore.resetRoom();
        ui.resetReturnToLobby();
        showLobby();
    });

    socket.on('playerJoined', function (payload) {
        roomStore.applyPlayerJoined(payload);
        if (ui.screen === 'room') {
            ui.renderRoom();
        }
    });

    socket.on('playerLeft', function (payload) {
        roomStore.applyPlayerLeft(payload);
        if (ui.screen === 'room') {
            ui.renderRoom();
        }
    });

    socket.on('playerReconnect', function (payload) {
        roomStore.applyPlayerJoined(payload);
        if (ui.screen === 'room') {
            ui.renderRoom();
        }
    });

    socket.on('playerReady', function (payload) {
        roomStore.applyPlayerReady(payload);
        if (ui.screen === 'room') {
            ui.renderRoom();
        }
    });

    // Match lifecycle.
    socket.on('gameCountdown', function (payload) {
        roomStore.applyCountdown(payload);
        if (roomStore.room) {
            if (ui.screen === 'room') {
                ui.renderRoom();
            } else {
                ui.showRoom();
            }
        }
    });

    socket.on('gameStart', function (snapshot) {
        roomStore.applyGameStart(snapshot);
        beginRoomGame(snapshot);
    });

    socket.on('gameState', handleGameState);

    socket.on('gameEnd', function (result) {
        roomStore.applyGameEnd(result);
        endRoomGame(result);
    });

    socket.on('gameError', function (payload) {
        var message = formatRoomError(payload, 'That action is not available right now.');
        if (ui.screen === 'room') {
            ui.setRoomError(message);
        } else {
            ui.setLobbyError(message);
        }
    });

    socket.on('roomError', handleRoomError);

    socket.on('welcome', handleWelcome);

    socket.on('playerDied', (data) => {
        const eaten = isUnnamedCell(data.playerEatenName || data.name)
            ? 'An unnamed cell'
            : (data.playerEatenName || data.name);
        window.chat.addSystemLine('{GAME} - <b>' + (eaten) + '</b> was eaten');
    });

    socket.on('playerDisconnect', (data) => {
        window.chat.addSystemLine('{GAME} - <b>' + (isUnnamedCell(data.name) ? 'An unnamed cell' : data.name) + '</b> disconnected.');
    });

    socket.on('playerJoin', (data) => {
        window.chat.addSystemLine('{GAME} - <b>' + (isUnnamedCell(data.name) ? 'An unnamed cell' : data.name) + '</b> joined.');
    });

    socket.on('leaderboard', (data) => {
        leaderboard = data.leaderboard;
        var status = '<span class="title">Leaderboard</span>';
        for (var i = 0; i < leaderboard.length; i++) {
            status += '<br />';
            if (leaderboard[i].id == player.id) {
                if (leaderboard[i].name.length !== 0)
                    status += '<span class="me">' + (i + 1) + '. ' + leaderboard[i].name + '</span>';
                else
                    status += '<span class="me">' + (i + 1) + '. An unnamed cell</span>';
            } else {
                if (leaderboard[i].name.length !== 0)
                    status += (i + 1) + '. ' + leaderboard[i].name;
                else
                    status += (i + 1) + '. An unnamed cell';
            }
        }
        document.getElementById('status').innerHTML = status;
    });

    socket.on('serverMSG', function (data) {
        window.chat.addSystemLine(data);
    });

    // Chat.
    socket.on('serverSendPlayerChat', function (data) {
        window.chat.addChatLine(data.sender, data.message, false);
    });

    // Handle movement.
    socket.on('serverTellPlayerMove', function (playerData, userData, foodsList, massList, virusList) {
        if (global.playerType == 'player') {
            player.x = playerData.x;
            player.y = playerData.y;
            player.hue = playerData.hue;
            player.massTotal = playerData.massTotal;
            player.cells = playerData.cells;
        }
        users = userData;
        foods = foodsList;
        viruses = virusList;
        fireFood = massList;
    });

    // Death.
    socket.on('RIP', function () {
        global.gameStart = false;
        render.drawErrorMessage('You died!', graph, global.screen);

        if (global.roomGame) {
            window.chat.addSystemLine('{GAME} - You were eaten. Waiting for the match to finish.');
            return;
        }

        window.setTimeout(() => {
            if (ui) {
                ui.showAuth('');
            }
            if (global.animLoopHandle) {
                window.cancelAnimationFrame(global.animLoopHandle);
                global.animLoopHandle = undefined;
            }
        }, 2500);
    });

    socket.on('kick', function (reason) {
        global.gameStart = false;
        global.kicked = true;
        global.disconnected = true;
        if (reason !== '') {
            render.drawErrorMessage('You were kicked for: ' + reason, graph, global.screen);
            connectionStatus.kicked(reason);
        }
        else {
            render.drawErrorMessage('You were kicked!', graph, global.screen);
            connectionStatus.kicked('');
        }
        socket.close();
    });
}

const isUnnamedCell = (name) => !name || name.length < 1;

const getPosition = (entity, player, screen) => {
    return {
        x: entity.x - player.x + screen.width / 2,
        y: entity.y - player.y + screen.height / 2
    }
}

window.requestAnimFrame = (function () {
    return window.requestAnimationFrame ||
        window.webkitRequestAnimationFrame ||
        window.mozRequestAnimationFrame ||
        window.msRequestAnimationFrame ||
        function (callback) {
            window.setTimeout(callback, 1000 / 60);
        };
})();

window.cancelAnimFrame = (function (handle) {
    return window.cancelAnimationFrame ||
        window.mozCancelAnimationFrame;
})();

function animloop() {
    global.animLoopHandle = window.requestAnimFrame(animloop);
    gameLoop();
}

function gameLoop() {
    if (global.gameStart) {
        graph.fillStyle = global.backgroundColor;
        graph.fillRect(0, 0, global.screen.width, global.screen.height);

        render.drawGrid(global, player, global.screen, graph);
        foods.forEach(food => {
            let position = getPosition(food, player, global.screen);
            render.drawFood(position, food, graph);
        });
        fireFood.forEach(fireFood => {
            let position = getPosition(fireFood, player, global.screen);
            render.drawFireFood(position, fireFood, playerConfig, graph);
        });
        viruses.forEach(virus => {
            let position = getPosition(virus, player, global.screen);
            render.drawVirus(position, virus, graph);
        });


        let borders = { // Position of the borders on the screen
            left: global.screen.width / 2 - player.x,
            right: global.screen.width / 2 + global.game.width - player.x,
            top: global.screen.height / 2 - player.y,
            bottom: global.screen.height / 2 + global.game.height - player.y
        }
        if (global.borderDraw) {
            render.drawBorder(borders, graph);
        }

        var cellsToDraw = [];
        for (var i = 0; i < users.length; i++) {
            let color = 'hsl(' + users[i].hue + ', 100%, 50%)';
            let borderColor = 'hsl(' + users[i].hue + ', 100%, 45%)';
            for (var j = 0; j < users[i].cells.length; j++) {
                cellsToDraw.push({
                    color: color,
                    borderColor: borderColor,
                    mass: users[i].cells[j].mass,
                    name: users[i].name,
                    radius: users[i].cells[j].radius,
                    x: users[i].cells[j].x - player.x + global.screen.width / 2,
                    y: users[i].cells[j].y - player.y + global.screen.height / 2
                });
            }
        }
        cellsToDraw.sort(function (obj1, obj2) {
            return obj1.mass - obj2.mass;
        });
        render.drawCells(cellsToDraw, playerConfig, global.toggleMassState, borders, graph);

        if (socket) {
            socket.emit('0', window.canvas.target); // playerSendTarget "Heartbeat".
        }
    }
}

window.addEventListener('resize', resize);

function resize() {
    if (!socket) return;

    player.screenWidth = c.width = global.screen.width = global.playerType == 'player' ? window.innerWidth : global.game.width;
    player.screenHeight = c.height = global.screen.height = global.playerType == 'player' ? window.innerHeight : global.game.height;

    if (global.playerType == 'spectator') {
        player.x = global.game.width / 2;
        player.y = global.game.height / 2;
    }

    socket.emit('windowResized', { screenWidth: global.screen.width, screenHeight: global.screen.height });
}

window.onload = function () {
    ui = new AppUI({
        sessionStore: sessionStore,
        roomStore: roomStore,
        actions: {
            login: function (payload) {
                ui.setBusy('auth', true);
                ensureConnection().emit('login', payload);
            },
            register: function (payload) {
                ui.setBusy('auth', true);
                ensureConnection().emit('register', payload);
            },
            guest: function (name) {
                sessionStore.setGuestName(name);
                roomStore.clearAccount();
                showLobby();
            },
            quickPlay: function (name) {
                startQuickPlay('player', name);
            },
            quickSpectate: function (name) {
                startQuickPlay('spectator', name);
            },
            refreshRooms: function () {
                roomStore.setRoomsLoading(true);
                ui.renderRoomList();
                ensureConnection().emit('listRooms');
            },
            createRoom: function (payload) {
                creatingRoom = true;
                ui.setBusy('lobby', true);
                ensureConnection();
                ensureGuestIdentity();
                socket.emit('createRoom', payload);
            },
            joinRoom: joinRoom,
            leaveRoom: leaveRoom,
            setReady: function (ready) {
                ensureConnection().emit('setReady', { ready: Boolean(ready) });
            },
            startGame: function () {
                if (roomStore.room) {
                    ensureConnection().emit('startGame', { id: roomStore.room.id });
                }
            },
            stopGame: function () {
                if (roomStore.room) {
                    ensureConnection().emit('stopGame', { id: roomStore.room.id });
                }
            },
            updateRoom: function (changes) {
                if (!roomStore.room) {
                    return;
                }
                ensureConnection().emit('updateRoom', Object.assign({ id: roomStore.room.id }, changes));
            },
            deleteRoom: function () {
                if (roomStore.room) {
                    ensureConnection().emit('deleteRoom', { id: roomStore.room.id });
                }
            },
            returnToLobby: returnToLobby,
            logout: function () {
                ensureConnection().emit('logout');
            }
        }
    });

    ensureConnection();

    if (sessionStore.token) {
        ui.setIdentity(identityLabel());
    } else {
        ui.setIdentity(identityLabel());
    }

    // Surface a guest name stored from a previous visit.
    var guestInput = document.getElementById('guestNameInput');
    if (guestInput && sessionStore.guestName) {
        guestInput.value = sessionStore.guestName;
    }
};
