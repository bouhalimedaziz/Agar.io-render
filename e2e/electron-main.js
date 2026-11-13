'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const { TcpClient } = require('../src/shared/tcp-socket');
const { createTcpBridge } = require('../src/electron/tcp-bridge');

const HOST = process.env.AGAR_SERVER_HOST || '127.0.0.1';
const PORT = Number(process.env.AGAR_SERVER_PORT);
const TIMEOUT = 30000;

if (!Number.isInteger(PORT) || PORT <= 0) {
    console.error('AGAR_SERVER_PORT is required.');
    process.exit(2);
}

let win = null;
let bridge = null;
let second = null;

function log(...args) {
    console.log('[e2e]', ...args);
}

function waitFor(emitter, event, predicate, timeout = TIMEOUT) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error('timed out waiting for ' + event));
        }, timeout);

        function handler(...args) {
            let matched = true;
            if (predicate) {
                try {
                    matched = predicate(...args);
                } catch (err) {
                    matched = false;
                }
            }
            if (matched) {
                cleanup();
                resolve(args);
            }
        }

        function cleanup() {
            clearTimeout(timer);
            emitter.off(event, handler);
        }

        emitter.on(event, handler);
    });
}

const RENDERER_HELPERS = `
(() => {
    const api = window.desktopTransport;
    if (!api) {
        throw new Error('desktopTransport is not available');
    }

    function wait(event, predicate, timeout = ${TIMEOUT}) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                api.off(event, handler);
                reject(new Error('timed out waiting for ' + event));
            }, timeout);

            function handler(...args) {
                let matched = true;
                if (predicate) {
                    try {
                        matched = predicate(...args);
                    } catch (err) {
                        matched = false;
                    }
                }
                if (matched) {
                    clearTimeout(timer);
                    api.off(event, handler);
                    resolve(args);
                }
            }

            api.on(event, handler);
        });
    }

    window.__e2e = {
        async connectAndRegister(username, password) {
            const connected = wait('connect');
            api.connect();
            await connected;

            const authed = wait('authOk', (payload) => Boolean(payload && payload.account));
            api.emit('register', { username, password });
            const [payload] = await authed;
            return { token: payload.token, account: payload.account };
        },

        async createAndJoin(name) {
            const created = wait('roomCreated');
            api.emit('createRoom', { name, visibility: 'public' });
            const [createdPayload] = await created;
            const room = createdPayload.room;

            const snapshot = wait('roomSnapshot');
            api.emit('joinRoom', { id: room.id });
            const [snap] = await snapshot;
            return {
                roomId: room.id,
                role: snap.role,
                restored: snap.restored,
                state: snap.game && snap.game.state
            };
        },

        async setReady() {
            const ready = wait('playerReady', (payload) => payload && payload.ready === true);
            api.emit('setReady', { ready: true });
            await ready;
            return true;
        },

        async startGame(roomId) {
            const countdown = wait('gameCountdown');
            const started = wait('gameStart', null, 45000);
            api.emit('startGame', { id: roomId });
            const [countdownPayload] = await countdown;
            const [startPayload] = await started;
            return {
                countdownMs: countdownPayload.countdownMs,
                state: startPayload.state,
                players: startPayload.players.length
            };
        },

        async play() {
            const update = wait('serverTellPlayerMove', null, 15000);
            api.emit('0', { x: 100, y: 100 });
            const [player] = await update;
            return {
                id: player.id,
                cells: player.cells ? player.cells.length : 0,
                mass: player.massTotal
            };
        },

        async stop(roomId) {
            const ended = wait('gameEnd', null, 30000);
            api.emit('stopGame', { id: roomId });
            const [result] = await ended;
            const scores = result.scores || [];
            const winner = scores.find((entry) => entry.winner) || null;
            return {
                reason: result.reason,
                winner: result.winner,
                winnerName: winner ? winner.name : null,
                players: scores.length
            };
        },

        async returnToLobby(roomId) {
            const state = wait('gameState', (snapshot) => snapshot && snapshot.state === 'lobby');
            api.emit('returnToLobby', { id: roomId });
            const [snapshot] = await state;
            return snapshot.state;
        },

        async disconnectAndResume(token) {
            const disconnected = wait('disconnect', null, 10000);
            api.disconnect();
            await disconnected;

            const connected = wait('connect');
            api.connect();
            await connected;

            const authed = wait('authOk', (payload) => payload && payload.resumed === true);
            const restored = wait('roomSnapshot', (payload) => payload && payload.restored === true);
            api.emit('auth', { token });
            const [authOk] = await authed;
            const [snapshot] = await restored;

            return {
                resumed: authOk.resumed,
                restored: snapshot.restored,
                role: snapshot.role,
                state: snapshot.game && snapshot.game.state
            };
        }
    };

    return true;
})()
`;

async function connectClient(client) {
    const connected = waitFor(client, 'connect');
    client.connect();
    await connected;
}

async function registerClient(client, username, password) {
    const authed = waitFor(client, 'authOk', (payload) => Boolean(payload && payload.account));
    client.emit('register', { username, password });
    const [payload] = await authed;
    return payload;
}

async function joinRoom(client, roomId) {
    const snapshot = waitFor(client, 'roomSnapshot');
    client.emit('joinRoom', { id: roomId });
    const [payload] = await snapshot;
    return payload;
}

async function run() {
    const suffix = String(Date.now()).slice(-8);
    const user1 = 'e2ep' + suffix;
    const user2 = 'e2es' + suffix;
    const password = 'password123';
    const roomName = 'E2E room ' + suffix;
    const steps = [];

    win = new BrowserWindow({
        show: false,
        width: 1024,
        height: 768,
        webPreferences: {
            preload: path.join(__dirname, '..', 'src', 'electron', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false
        }
    });

    win.webContents.on('console-message', (event) => {
        log('renderer console:', event.message);
    });
    win.webContents.on('did-fail-load', (_event, code, description, url) => {
        console.error('[e2e] failed to load', url, code, description);
    });
    win.webContents.on('render-process-gone', (_event, details) => {
        console.error('[e2e] renderer gone', details);
    });

    bridge = createTcpBridge({
        ipcMain,
        getWindow: () => win,
        createClient: (options) => new TcpClient(options),
        clientOptions: {
            host: HOST,
            port: PORT,
            reconnect: true,
            reconnectDelay: 500,
            reconnectMaxDelay: 2000
        },
        logger: console
    });
    bridge.start();
    log('bridge started');

    log('loading client page');
    await win.loadFile(path.join(__dirname, '..', 'bin', 'client', 'index.html'));
    log('client page loaded');
    await win.webContents.executeJavaScript(RENDERER_HELPERS);
    log('renderer helpers installed');
    log('transport state', await win.webContents.executeJavaScript(
        'window.desktopTransport.getState()'
    ));

    // 1. Login through the real preload bridge.
    const primary = await win.webContents.executeJavaScript(
        'window.__e2e.connectAndRegister(' +
        JSON.stringify(user1) + ', ' + JSON.stringify(password) + ')'
    );
    steps.push('register');
    log('registered primary player', primary.account.username);

    // 2. Create and join a room through the bridge.
    const room = await win.webContents.executeJavaScript(
        'window.__e2e.createAndJoin(' + JSON.stringify(roomName) + ')'
    );
    steps.push('createRoom+joinRoom');
    log('joined room', room.roomId, 'as', room.role);

    // 3. Join the same room as a second player over raw TCP.
    second = new TcpClient({
        host: HOST,
        port: PORT,
        reconnect: false
    });
    await connectClient(second);
    await registerClient(second, user2, password);
    const secondSnapshot = await joinRoom(second, room.roomId);
    steps.push('secondPlayerJoin');
    log('second player joined as', secondSnapshot.role);

    // 4. Ready both players and start the match.
    const secondReady = waitFor(second, 'playerReady', (payload) => payload && payload.ready === true);
    await win.webContents.executeJavaScript('window.__e2e.setReady()');
    second.emit('setReady', { ready: true });
    await secondReady;
    steps.push('setReady');

    const secondStarted = waitFor(second, 'gameStart', null, 45000);
    const started = await win.webContents.executeJavaScript(
        'window.__e2e.startGame(' + JSON.stringify(room.roomId) + ')'
    );
    await secondStarted;
    steps.push('startGame');
    log('game started with', started.players, 'players');

    // 5. Send input from both players and receive world updates.
    const secondUpdate = waitFor(second, 'serverTellPlayerMove', null, 15000);
    const primaryUpdate = await win.webContents.executeJavaScript('window.__e2e.play()');
    second.emit('0', { x: 200, y: 200 });
    const [secondPlayer] = await secondUpdate;
    steps.push('play');
    log('received updates for', primaryUpdate.id, 'and', secondPlayer.id);

    // 6. Finish the match through the owner.
    const secondEnd = waitFor(second, 'gameEnd', null, 30000);
    const result = await win.webContents.executeJavaScript(
        'window.__e2e.stop(' + JSON.stringify(room.roomId) + ')'
    );
    await secondEnd;
    if (!result.players || result.players < 2) {
        throw new Error('gameEnd did not include both players');
    }
    steps.push('gameEnd');
    log('game ended:', result.reason, 'winner:', result.winnerName);

    // 7. Return the room to the lobby.
    const lobbyState = await win.webContents.executeJavaScript(
        'window.__e2e.returnToLobby(' + JSON.stringify(room.roomId) + ')'
    );
    if (lobbyState !== 'lobby') {
        throw new Error('room did not return to lobby');
    }
    steps.push('returnToLobby');

    // 8. Disconnect the Electron client and resume the account session.
    const resumed = await win.webContents.executeJavaScript(
        'window.__e2e.disconnectAndResume(' + JSON.stringify(primary.token) + ')'
    );
    if (!resumed.resumed || !resumed.restored) {
        throw new Error('session or room membership was not restored');
    }
    steps.push('disconnect+reconnect');
    log('session resumed, room restored as', resumed.role);

    return {
        ok: true,
        steps,
        primary: primary.account.username,
        second: user2,
        roomId: room.roomId,
        gamePlayers: result.players,
        winner: result.winnerName,
        resumed: resumed.resumed,
        restored: resumed.restored
    };
}

app.whenReady().then(async () => {
    log('app ready');
    try {
        const result = await run();
        console.log('E2E_RESULT ' + JSON.stringify(result));
        cleanup();
        app.exit(0);
    } catch (err) {
        console.error('E2E_FAILURE', err && err.stack ? err.stack : err);
        cleanup();
        app.exit(1);
    }
});

function cleanup() {
    try {
        if (second) {
            second.disconnect('e2e complete');
        }
        if (bridge) {
            bridge.stop();
        }
    } catch (err) {
        console.error('[e2e] cleanup error', err);
    }
}

app.on('window-all-closed', () => {
    // The test controls the lifecycle explicitly.
});
