/*jslint bitwise: true, node: true */
'use strict';

const express = require('express');
const app = express();
const http = require('http').Server(app);

const loggingRepositry = require('./repositories/logging-repository');
const chatRepository = require('./repositories/chat-repository');
const config = require('../../config');
const util = require('./lib/util');
const {
    createTransportHub,
    createTcpServer
} = require('./transport');
const {WsServer} = require('../shared/ws-socket');
const db = require('./sql');
const {createAccountRepository} = require('./repositories/account-repository');
const {createSessionRepository} = require('./repositories/session-repository');
const {createAuthService, AuthError, AUTH_ERROR_CODES} = require('./auth');
const {createRoomManager, RoomLobby, ROOM_ERROR_CODES} = require('./rooms');
const {GameSession} = require('./game');
const {normalizeCommandArgs, normalizeChatMessage} = require('./game/validation');
const {createMatchRepository} = require('./repositories/match-repository');

let sockets = {};

const authService = createAuthService({
    accountRepository: createAccountRepository(db),
    sessionRepository: createSessionRepository(db),
    loggingRepository: loggingRepositry,
    config: config.auth
});
const socketSessions = new Map();

const roomManager = createRoomManager({
    defaults: {
        mapWidth: config.gameWidth,
        mapHeight: config.gameHeight,
        maxFood: config.maxFood,
        maxVirus: config.maxVirus,
        foodMass: config.foodMass,
        defaultPlayerMass: config.defaultPlayerMass,
        gameMass: config.gameMass,
        maxPlayers: config.rooms.defaultMaxPlayers,
        timeLimitMs: config.rooms.defaultTimeLimitMs,
        scoreLimit: config.rooms.defaultScoreLimit
    },
    emptyRoomGraceMs: config.rooms.emptyRoomGraceMs,
    maxRooms: config.rooms.maxRooms
});

const sessionCleanupTimer = setInterval(() => {
    authService.cleanupExpiredSessions()
        .catch((err) => console.error('Error cleaning expired sessions', err));
}, 60 * 60 * 1000);
if (typeof sessionCleanupTimer.unref === 'function') {
    sessionCleanupTimer.unref();
}

const transport = createTransportHub();

let tcpServer = null;
if (config.tcp && config.tcp.enabled !== false) {
    tcpServer = createTcpServer({
        requireHandshake: true,
        handshakeTimeout: config.tcp.handshakeTimeout,
        heartbeatInterval: config.tcp.heartbeatInterval,
        heartbeatTimeout: config.tcp.heartbeatTimeout,
        maxPayloadSize: config.tcp.maxPayloadSize
    });
    tcpServer.on('error', (err) => console.error('[TCP] Server error:', err));
    transport.addTransport('tcp', tcpServer);
}

// WebSocket transport on the HTTP port (same port that serves the client page).
// Used for the cross-network bonus: public hosts only expose HTTP(S), and a
// browser can play directly at http(s)://<host>/ without installing anything.
let wsServer = null;
if (!config.ws || config.ws.enabled !== false) {
    wsServer = new WsServer({
        path: (config.ws && config.ws.path) || '/game',
        heartbeatInterval: (config.ws && config.ws.heartbeatInterval) || 1000,
        heartbeatTimeout: (config.ws && config.ws.heartbeatTimeout) || 5000,
        maxPayloadSize: config.tcp.maxPayloadSize
    });
    wsServer.attach(http);
    transport.addTransport('ws', wsServer);
}

app.use(express.static(__dirname + '/../client'));

function getHandshakeToken(handshake) {
    const auth = (handshake && handshake.auth) || {};
    const query = (handshake && handshake.query) || {};
    let token = auth.token || query.token;

    // Repeated query parameters become arrays.
    if (Array.isArray(token)) {
        token = token[0];
    }

    return typeof token === 'string' && token.length > 0 ? token : null;
}

function getTokenFromPayload(payload) {
    if (typeof payload === 'string') {
        return payload;
    }
    if (payload && typeof payload.token === 'string') {
        return payload.token;
    }
    return null;
}

function sendAuthError(socket, err) {
    if (err instanceof AuthError) {
        socket.emit('authError', err.toPayload());
        return;
    }

    console.error('[AUTH] Unexpected authentication error:', err);
    socket.emit('authError', {
        code: AUTH_ERROR_CODES.INTERNAL_ERROR,
        message: 'Authentication failed.'
    });
}

function bindSession(socket, account, token, expiresAt, resumed) {
    const previousIdentity = socketIdentity(socket);

    // A token can only be active on one connection. This also covers a client
    // that reconnects before the server has noticed the old socket is gone.
    // Claim the token before disconnecting the previous socket so the old
    // socket's disconnect handler does not mark the session as disconnected.
    const previousSocket = socketSessions.get(token);
    socket.auth = {account, token};
    socketSessions.set(token, socket);

    if (previousSocket && previousSocket !== socket) {
        previousSocket.emit('authError', {
            code: AUTH_ERROR_CODES.SESSION_REPLACED,
            message: 'This session was resumed from another connection.'
        });
        previousSocket.disconnect('session resumed elsewhere');
    }

    const payload = {
        account,
        token,
        resumed: Boolean(resumed)
    };
    if (expiresAt !== undefined && expiresAt !== null) {
        payload.expiresAt = expiresAt;
    }
    socket.emit('authOk', payload);
    roomLobby.handleAuthChange(socket, previousIdentity);
}

function disconnectRevokedSessions(tokens, currentSocket) {
    if (!Array.isArray(tokens) || tokens.length === 0) {
        return;
    }

    for (const token of tokens) {
        const otherSocket = socketSessions.get(token);
        socketSessions.delete(token);

        if (otherSocket && otherSocket !== currentSocket) {
            otherSocket.emit('authError', {
                code: AUTH_ERROR_CODES.SESSION_REPLACED,
                message: 'This account signed in from another connection.'
            });
            otherSocket.disconnect('session replaced');
        }
    }
}

async function resumeHandshakeSession(socket, token) {
    try {
        const result = await authService.resumeSession(token);
        bindSession(socket, result.account, token, result.session.expiresAt, true);
    } catch (err) {
        sendAuthError(socket, err);
    }
}

function handleSocketSessionDisconnect(socket) {
    const token = socket.auth && socket.auth.token;
    if (!token) {
        return;
    }

    // The token may already belong to a newer connection (reconnect or
    // session replacement). In that case the old socket must leave the
    // session state alone.
    if (socketSessions.get(token) !== socket) {
        return;
    }

    socketSessions.delete(token);
    authService.markDisconnected(token)
        .catch((err) => console.error('Error marking session disconnected', err));
}

function attachAuthHandlers(socket) {
    const ipAddress = socket.remoteAddress || 'unknown';

    socket.on('register', async (payload) => {
        try {
            const result = await authService.register(payload, ipAddress);
            bindSession(socket, result.account, result.token, result.expiresAt, false);
        } catch (err) {
            sendAuthError(socket, err);
        }
    });

    socket.on('login', async (payload) => {
        try {
            const result = await authService.login(payload, ipAddress);
            disconnectRevokedSessions(result.revokedTokens, socket);
            bindSession(socket, result.account, result.token, result.expiresAt, false);
        } catch (err) {
            sendAuthError(socket, err);
        }
    });

    const resumeHandler = async (payload) => {
        const token = getTokenFromPayload(payload) ||
            (socket.auth && socket.auth.token);

        try {
            const result = await authService.resumeSession(token);
            bindSession(socket, result.account, token, result.session.expiresAt, true);
        } catch (err) {
            sendAuthError(socket, err);
        }
    };

    socket.on('auth', resumeHandler);
    socket.on('resumeSession', resumeHandler);

    socket.on('logout', async () => {
        const token = socket.auth && socket.auth.token;
        if (!token) {
            socket.emit('loggedOut', {});
            return;
        }

        const previousIdentity = socketIdentity(socket);

        try {
            await authService.logout(token);
        } catch (err) {
            console.error('Error logging out session', err);
        }

        if (socketSessions.get(token) === socket) {
            socketSessions.delete(token);
        }
        socket.auth = null;
        roomLobby.handleAuthChange(socket, previousIdentity);
        socket.emit('loggedOut', {});
    });
}

function socketIdentity(socket) {
    const account = socket.auth && socket.auth.account;
    if (account) {
        return {
            id: 'account:' + account.id,
            accountId: account.id,
            account,
            name: account.username
        };
    }

    return {
        id: 'guest:' + socket.id,
        accountId: null,
        account: null,
        name: socket.displayName || 'Guest'
    };
}

const matchRepository = createMatchRepository(db);

const roomLobby = new RoomLobby({
    roomManager,
    transport,
    identityForSocket: socketIdentity,
    disconnectGraceMs: config.rooms.disconnectGraceMs,
    gameConfig: config,
    onMatchFinished: (result, room) => {
        if (!result || !Array.isArray(result.scores) || result.scores.length === 0) {
            return null;
        }
        return matchRepository.saveMatch(result, room);
    },
    onSocketEnterRoom: (socket) => {
        // A `gotit` received before the socket joined a room creates a
        // default-game entry keyed by the socket id. Drop it when the socket
        // moves into a room, otherwise the default game's heartbeat timeout
        // would later kick a player who is actually alive in a room.
        if (socket.gameSession === defaultGame && socket.gameMemberId) {
            defaultGame.removeMember(socket.gameMemberId);
        }
        defaultGame.removeMember(socket.id);
    }
});
roomLobby.startCleanup(config.rooms.cleanupIntervalMs);

function emitDefaultToMember(memberId, event, ...args) {
    const socket = sockets[memberId];
    if (socket) {
        socket.emit(event, ...args);
    }
}

function emitDefaultToRoom(event, payload) {
    if (!defaultGame) {
        return;
    }

    for (const memberId of defaultGame.getMemberIds()) {
        emitDefaultToMember(memberId, event, payload);
    }
}

const defaultGame = new GameSession({
    roomId: null,
    competitive: false,
    settings: {
        mapWidth: config.gameWidth,
        mapHeight: config.gameHeight,
        maxFood: config.maxFood,
        maxVirus: config.maxVirus,
        foodMass: config.foodMass,
        defaultPlayerMass: config.defaultPlayerMass,
        gameMass: config.gameMass,
        maxPlayers: config.rooms.defaultMaxPlayers,
        timeLimitMs: 0,
        scoreLimit: 0
    },
    config,
    scoreWeights: config.game && config.game.scoreWeights,
    emitToMember: emitDefaultToMember,
    emitToRoom: emitDefaultToRoom,
    onHeartbeatTimeout: (memberId, reason) => {
        const socket = sockets[memberId];
        if (socket) {
            socket.emit('kick', reason);
            socket.disconnect(reason);
        }
    }
});
defaultGame.startRunning();

transport.on('connection', function (socket) {
    let type = socket.handshake.query.type;
    console.log('User has connected: ', type);

    attachAuthHandlers(socket);
    roomLobby.attachSocket(socket);

    const handshakeToken = getHandshakeToken(socket.handshake);
    if (handshakeToken) {
        resumeHandshakeSession(socket, handshakeToken);
    }

    switch (type) {
        case 'player':
            addPlayer(socket);
            break;
        case 'spectator':
            addSpectator(socket);
            break;
        default:
            console.log('Unknown user type, not doing anything.');
    }
});

function gameSizesForSocket(socket, session) {
    if (session) {
        return {
            width: session.settings.mapWidth,
            height: session.settings.mapHeight
        };
    }

    const membership = roomManager.getMembership(socketIdentity(socket).id);
    if (membership) {
        return {
            width: membership.room.settings.mapWidth,
            height: membership.room.settings.mapHeight
        };
    }

    return {
        width: config.gameWidth,
        height: config.gameHeight
    };
}

function socketsForGameMember(session, memberId) {
    const matches = [];
    for (const socket of transport.sockets.values()) {
        if (socket.gameSession === session && socket.gameMemberId === memberId) {
            matches.push(socket);
        }
    }
    return matches;
}

const addPlayer = (socket) => {
    socket.playerName = null;
    socket.admin = false;
    socket.gameSession = null;
    socket.gameMemberId = null;

    socket.on('gotit', function (clientPlayerData) {
        if (!clientPlayerData || typeof clientPlayerData !== 'object') {
            clientPlayerData = {};
        }
        const account = socket.auth && socket.auth.account;
        const identity = socketIdentity(socket);
        const membership = roomManager.getMembership(identity.id);

        // An authenticated account owns its display name, so a client cannot
        // join under someone else's account name.
        if (account) {
            clientPlayerData.name = account.username;
        }

        if (!util.validNick(clientPlayerData.name)) {
            socket.emit('kick', 'Invalid username.');
            socket.disconnect();
            return;
        }

        const sanitizedName = String(clientPlayerData.name).replace(/(<([^>]+)>)/ig, '');
        socket.playerName = sanitizedName;
        roomLobby.updateMemberName(socket, sanitizedName);
        sockets[socket.id] = socket;

        let session = null;
        let memberId = null;

        if (membership) {
            if (membership.role !== 'player') {
                // A player transport attached to a room spectator does not
                // spawn a playable cell.
                return;
            }

            session = roomLobby.getSession(membership.room.id);
            if (!session) {
                socket.emit('roomError', {
                    code: ROOM_ERROR_CODES.ROOM_NOT_FOUND,
                    message: 'The room game is not available.'
                });
                return;
            }
            memberId = identity.id;
        } else {
            session = defaultGame;
            memberId = socket.id;
        }

        socket.gameSession = session;
        socket.gameMemberId = memberId;

        session.addPlayer(memberId, {
            name: sanitizedName,
            accountId: account ? account.id : null,
            admin: Boolean(socket.admin),
            screenWidth: clientPlayerData.screenWidth,
            screenHeight: clientPlayerData.screenHeight
        }, {
            // Room matches spawn every participant when the game starts. A
            // repeated `gotit` (for example after dying) must not respawn a
            // player mid-match. The default non-competitive world keeps the
            // legacy respawn behavior.
            spawn: session === defaultGame
        });

        if (session === defaultGame && !socket.joinedDefaultGame) {
            socket.joinedDefaultGame = true;
            transport.emit('playerJoin', { name: sanitizedName });
        }

        console.log('[INFO] Player ' + sanitizedName + ' connected to ' +
            (session.roomId === null ? 'the default game' : session.roomId));
    });

    socket.on('pingcheck', () => {
        socket.emit('pongcheck');
    });

    socket.on('windowResized', (data) => {
        if (!data || typeof data !== 'object' || !socket.gameSession || !socket.gameMemberId) {
            return;
        }

        socket.gameSession.setScreenSize(
            socket.gameMemberId,
            data.screenWidth,
            data.screenHeight
        );
    });

    socket.on('respawn', () => {
        const session = socket.gameSession || roomLobby.getSessionForSocket(socket);

        if (session && session !== defaultGame) {
            if (session.state === 'running') {
                socket.emit('gameError', {
                    code: 'respawn_not_allowed',
                    message: 'Respawning is not allowed while the match is running.'
                });
                return;
            }

            // Room games spawn everyone when the next match starts; there is
            // no per-player respawn in the lobby or after the match.
            const sizes = gameSizesForSocket(socket, session);
            socket.emit('welcome', {}, {
                width: sizes.width,
                height: sizes.height
            });
            return;
        }

        if (session && socket.gameMemberId) {
            session.despawnPlayer(socket.gameMemberId);
        }

        const sizes = gameSizesForSocket(socket, session);
        socket.emit('welcome', {}, {
            width: sizes.width,
            height: sizes.height
        });
        console.log('[INFO] User ' + (socket.playerName || socket.id) + ' has respawned');
    });

    socket.on('disconnect', () => {
        const wasDefaultGame = socket.gameSession === defaultGame;
        const playerName = socket.playerName;

        if (wasDefaultGame && socket.gameMemberId) {
            defaultGame.removeMember(socket.gameMemberId);
        }

        // A socket can still own a default-game entry from a `gotit` sent
        // before it joined a room, or from a default-game spectator slot.
        defaultGame.removeMember(socket.id);

        delete sockets[socket.id];
        handleSocketSessionDisconnect(socket);
        roomLobby.handleDisconnect(socket);

        if (wasDefaultGame) {
            emitDefaultToRoom('playerDisconnect', { name: playerName });
        }

        console.log('[INFO] User ' + (playerName || socket.id) + ' has disconnected');
    });

    socket.on('playerChat', (data) => {
        const message = normalizeChatMessage(data);
        if (message === null) {
            return;
        }

        const sender = socket.playerName || 'Guest';

        if (config.logChat === 1) {
            console.log('[CHAT] [' + (new Date()).getHours() + ':' + (new Date()).getMinutes() + '] ' + sender + ': ' + message);
        }

        const session = socket.gameSession || defaultGame;
        session.emitToRoom('serverSendPlayerChat', {
            roomId: session.roomId,
            sender,
            message: message.substring(0, 35)
        });

        chatRepository.logChatMessage(sender, message, socket.remoteAddress, session.roomId)
            .catch((err) => console.error("Error when attempting to log chat message", err));
    });

    socket.on('pass', async (data) => {
        const args = normalizeCommandArgs(data);
        const password = args[0];

        if (password === config.adminPass) {
            console.log('[ADMIN] ' + socket.playerName + ' just logged in as an admin.');
            socket.admin = true;
            const session = socket.gameSession || defaultGame;
            session.setAdmin(socket.gameMemberId, true);
            session.emitToRoom('serverMSG', 'Welcome back ' + socket.playerName);
            session.emitToRoom('serverMSG', socket.playerName + ' just logged in as an admin.');
        } else {
            console.log('[ADMIN] ' + socket.playerName + ' attempted to log in with an incorrect password.');

            socket.emit('serverMSG', 'Password incorrect, attempt logged.');

            loggingRepositry.logFailedLoginAttempt(socket.playerName, socket.remoteAddress)
                .catch((err) => console.error("Error when attempting to log failed login attempt", err));
        }
    });

    socket.on('kick', (data) => {
        if (!socket.admin) {
            socket.emit('serverMSG', 'You are not permitted to use this command.');
            return;
        }

        const args = normalizeCommandArgs(data);
        const targetName = args[0];

        if (!targetName) {
            socket.emit('serverMSG', 'Usage: /kick <player> [reason]');
            return;
        }

        const reason = args.slice(1).join(' ').substring(0, 100);
        const session = socket.gameSession || defaultGame;
        const target = session.snapshot().players.find(
            (player) => player.name === targetName && !player.admin
        );

        if (!target) {
            socket.emit('serverMSG', 'Could not locate user or user is an admin.');
            return;
        }

        if (session === defaultGame) {
            for (const targetSocket of socketsForGameMember(session, target.id)) {
                targetSocket.emit('kick', reason);
                targetSocket.disconnect(reason);
            }

            session.despawnPlayer(target.id);
            defaultGame.removeMember(target.id);
        } else if (!roomLobby.kickMember(target.id, reason)) {
            socket.emit('serverMSG', 'Could not locate user or user is an admin.');
            return;
        }

        console.log('[ADMIN] User ' + target.name + ' kicked successfully by ' +
            socket.playerName + (reason === '' ? '' : ' for reason ' + reason));

        socket.emit('serverMSG', 'User ' + target.name + ' was kicked by ' + socket.playerName);
        session.emitToRoom('serverMSG', target.name + ' was kicked by ' + socket.playerName);
    });

    // Heartbeat function, update everytime.
    socket.on('0', (target) => {
        if (socket.gameSession && socket.gameMemberId) {
            socket.gameSession.setTarget(socket.gameMemberId, target);
        }
    });

    socket.on('1', function () {
        if (socket.gameSession && socket.gameMemberId) {
            socket.gameSession.fireFood(socket.gameMemberId);
        }
    });

    socket.on('2', () => {
        if (socket.gameSession && socket.gameMemberId) {
            socket.gameSession.split(socket.gameMemberId);
        }
    });
};

const addSpectator = (socket) => {
    socket.playerName = '';

    socket.on('gotit', function () {
        const identity = socketIdentity(socket);
        const membership = roomManager.getMembership(identity.id);
        sockets[socket.id] = socket;

        if (membership) {
            if (membership.role !== 'spectator') {
                // A spectator transport attached to a room player does not
                // become a room spectator.
                return;
            }

            const session = roomLobby.getSession(membership.room.id);
            if (session) {
                session.addSpectator(identity.id);
                socket.gameSession = session;
                socket.gameMemberId = identity.id;
            }
            return;
        }

        defaultGame.addSpectator(socket.id);
        socket.gameSession = defaultGame;
        socket.gameMemberId = socket.id;
        transport.emit('playerJoin', { name: '' });
    });

    socket.on('disconnect', () => {
        if (socket.gameSession === defaultGame && socket.gameMemberId) {
            defaultGame.removeMember(socket.gameMemberId);
        }

        delete sockets[socket.id];
        handleSocketSessionDisconnect(socket);
        roomLobby.handleDisconnect(socket);
    });

    socket.emit("welcome", {}, {
        width: config.gameWidth,
        height: config.gameHeight
    });
}

if (tcpServer) {
    const tcpaddress = process.env.TCP_HOST || config.tcp.host;
    const tcpport = parseInt(process.env.TCP_PORT || config.tcp.port, 10);
    tcpServer.listen(tcpport, tcpaddress, () => {
        console.log('[DEBUG] TCP listening on ' + tcpaddress + ':' + tcpport);
    });
}

// Don't touch, IP configurations.
var ipaddress = process.env.OPENSHIFT_NODEJS_IP || process.env.IP || config.host;
var serverport = process.env.OPENSHIFT_NODEJS_PORT || process.env.PORT || config.port;
http.listen(serverport, ipaddress, () => {
    console.log('[DEBUG] Listening on ' + ipaddress + ':' + serverport);
    if (wsServer) {
        console.log('[DEBUG] WebSocket game endpoint on ws://' + ipaddress + ':' + serverport + wsServer.options.path);
    }
});

let shuttingDown = false;

/**
 * Graceful shutdown: tell every client the server is going away, stop game
 * sessions and room timers, then close both transports and the HTTP server.
 * The second signal (or a stuck transport) falls back to a hard exit.
 */
function shutdown(signal) {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    console.log('[INFO] Received ' + signal + ', shutting down.');

    clearInterval(sessionCleanupTimer);
    transport.emit('serverShutdown', {
        reason: 'server_shutdown',
        signal
    });

    roomLobby.stop();
    defaultGame.close();

    const fallback = setTimeout(() => process.exit(0), 5000);
    if (typeof fallback.unref === 'function') {
        fallback.unref();
    }

    transport.close(() => {
        http.close(() => {
            if (typeof db.close !== 'function') {
                process.exit(0);
                return;
            }

            db.close((err) => {
                if (err) {
                    console.error('Error closing the database connection.', err);
                }
                process.exit(0);
            });
        });
    });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
