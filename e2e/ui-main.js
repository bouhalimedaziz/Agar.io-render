'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const { TcpClient } = require('../src/shared/tcp-socket');
const { createTcpBridge } = require('../src/electron/tcp-bridge');

const HOST = process.env.AGAR_SERVER_HOST || '127.0.0.1';
const PORT = Number(process.env.AGAR_SERVER_PORT);
const TIMEOUT = 20000;

if (!Number.isInteger(PORT) || PORT <= 0) {
    console.error('AGAR_SERVER_PORT is required.');
    process.exit(2);
}

let win = null;
let bridge = null;
let second = null;
const rendererErrors = [];

function log(...args) {
    console.log('[ui-e2e]', ...args);
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function js(code) {
    return win.webContents.executeJavaScript(code);
}

async function waitFor(expression, label, timeout = TIMEOUT) {
    const deadline = Date.now() + timeout;
    let lastError = null;

    while (Date.now() < deadline) {
        try {
            const value = await js(expression);
            if (value) {
                return value;
            }
        } catch (err) {
            lastError = err;
        }
        await delay(100);
    }

    throw new Error(
        'Timed out waiting for ' + (label || expression) +
        (lastError ? ' (' + lastError.message + ')' : '')
    );
}

async function visible(id) {
    return js(`(() => {
        const el = document.getElementById(${JSON.stringify(id)});
        if (!el) { return false; }
        if (el.classList.contains('is-hidden')) { return false; }
        return window.getComputedStyle(el).display !== 'none';
    })()`);
}

async function click(id) {
    await js(`(() => {
        const el = document.getElementById(${JSON.stringify(id)});
        if (!el) { throw new Error('missing element ${id}'); }
        el.click();
        return true;
    })()`);
}

async function setInput(id, value) {
    await js(`(() => {
        const el = document.getElementById(${JSON.stringify(id)});
        if (!el) { throw new Error('missing input ${id}'); }
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return el.value;
    })()`);
}

async function submit(id) {
    await js(`(() => {
        const form = document.getElementById(${JSON.stringify(id)});
        if (!form) { throw new Error('missing form ${id}'); }
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        return true;
    })()`);
}

function waitForEvent(emitter, event, predicate, timeout = TIMEOUT) {
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

async function connectSecond(username, password) {
    second = new TcpClient({
        host: HOST,
        port: PORT,
        reconnect: false
    });

    const connected = waitForEvent(second, 'connect');
    second.connect();
    await connected;

    const authed = waitForEvent(second, 'authOk', (payload) => Boolean(payload && payload.account));
    second.emit('register', { username, password });
    const [auth] = await authed;
    return auth;
}

async function joinSecond(code) {
    const snapshot = waitForEvent(second, 'roomSnapshot');
    second.emit('joinRoom', { code });
    const [payload] = await snapshot;
    return payload;
}

async function readySecond() {
    const ready = waitForEvent(second, 'playerReady', (payload) => payload && payload.ready === true);
    second.emit('setReady', { ready: true });
    await ready;
}

async function run() {
    const suffix = String(Date.now()).slice(-8);
    const username = 'uiuser' + suffix;
    const secondUser = 'uisecond' + suffix;
    const password = 'password123';
    const roomName = 'UI room ' + suffix;
    const guestName = 'Guest' + suffix;
    const steps = [];

    win = new BrowserWindow({
        show: false,
        width: 1100,
        height: 820,
        webPreferences: {
            preload: path.join(__dirname, '..', 'src', 'electron', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false
        }
    });

    win.webContents.on('console-message', (event) => {
        if (event && /Uncaught|ReferenceError|TypeError/i.test(event.message || '')) {
            rendererErrors.push(event.message);
        }
        log('renderer console:', event && event.message);
    });
    win.webContents.on('did-fail-load', (_event, code, description, url) => {
        console.error('[ui-e2e] failed to load', url, code, description);
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

    await win.loadFile(path.join(__dirname, '..', 'bin', 'client', 'index.html'));
    log('client loaded');

    await waitFor(
        `!document.getElementById('authScreen').classList.contains('is-hidden')`,
        'auth screen'
    );
    steps.push('authScreen');

    // Register through the real form.
    await click('registerTab');
    await setInput('registerUsername', username);
    await setInput('registerPassword', password);
    await setInput('registerConfirm', password);
    await submit('registerForm');

    await waitFor(
        `!document.getElementById('lobbyScreen').classList.contains('is-hidden')`,
        'lobby after register',
        30000
    );
    const identity = await js(`document.getElementById('lobbyIdentity').textContent`);
    if (identity.indexOf(username) === -1) {
        throw new Error('lobby identity did not show the account: ' + identity);
    }
    steps.push('register+lobby');

    // Create a room through the form. The client auto-joins it.
    await setInput('createRoomName', roomName);
    await submit('createRoomForm');

    await waitFor(
        `!document.getElementById('roomScreen').classList.contains('is-hidden')`,
        'room screen after create',
        30000
    );
    const roomTitle = await js(`document.getElementById('roomName').textContent`);
    if (roomTitle !== roomName) {
        throw new Error('room name mismatch: ' + roomTitle);
    }
    const roomCode = await js(`document.getElementById('roomCode').textContent`);
    if (!roomCode || roomCode.length < 4) {
        throw new Error('room code missing');
    }
    const rosterCount = await js(
        `document.querySelectorAll('#roomPlayerList .roster-row').length`
    );
    if (rosterCount !== 1) {
        throw new Error('expected one player in the roster, found ' + rosterCount);
    }
    const settingsVisible = await visible('roomSettings');
    if (!settingsVisible) {
        throw new Error('owner settings were not visible');
    }
    steps.push('createRoom+autoJoin');

    // Change a setting through the form and confirm it is accepted.
    await setInput('settingMaxPlayers', '6');
    await setInput('settingTimeLimit', '1');
    await submit('roomSettingsForm');
    await delay(600);
    const roomError = await js(`document.getElementById('roomError').textContent`);
    if (roomError) {
        throw new Error('room settings error: ' + roomError);
    }
    const maxPlayersValue = await js(`document.getElementById('settingMaxPlayers').value`);
    if (maxPlayersValue !== '6') {
        throw new Error('settings form did not keep the saved value');
    }
    steps.push('updateRoomSettings');

    // Second player joins over raw TCP with the visible room code.
    const auth = await connectSecond(secondUser, password);
    const snapshot = await joinSecond(roomCode);
    if (!snapshot || !snapshot.room) {
        throw new Error('second player did not receive a room snapshot');
    }
    await waitFor(
        `document.querySelectorAll('#roomPlayerList .roster-row').length === 2`,
        'second player in roster'
    );
    steps.push('secondPlayerJoin');

    // Both players ready through the UI/protocol, then start from the UI.
    await readySecond();
    await click('readyButton');
    await waitFor(
        `document.getElementById('readyButton').textContent === 'Cancel ready'`,
        'primary ready state'
    );
    await waitFor(
        `document.getElementById('startGameButton').disabled === false`,
        'start button enabled',
        15000
    );
    steps.push('readyUp');

    await js(`window.__uiGameUpdates = 0;
        window.desktopTransport.on('serverTellPlayerMove', () => {
            window.__uiGameUpdates += 1;
        });
        true;`);

    await click('startGameButton');
    await waitFor(
        `document.getElementById('gameAreaWrapper').classList.contains('is-active')`,
        'game screen',
        30000
    );
    await waitFor(
        `!document.getElementById('gameHud').classList.contains('is-hidden')`,
        'game HUD',
        15000
    );
    const hudLabel = await js(`document.getElementById('gameRoomLabel').textContent`);
    if (hudLabel.indexOf(roomName) === -1) {
        throw new Error('game HUD label missing the room name: ' + hudLabel);
    }
    steps.push('startGame');

    await waitFor('window.__uiGameUpdates > 0', 'gameplay updates', 20000);
    steps.push('gameplayUpdates');

    // End the match from the owner HUD.
    await click('gameStopButton');
    await waitFor(
        `!document.getElementById('gameOverOverlay').classList.contains('is-hidden')`,
        'game over overlay',
        30000
    );
    const title = await js(`document.getElementById('gameOverTitle').textContent`);
    const scoreRows = await js(
        `document.querySelectorAll('#gameOverScores .score-row').length`
    );
    if (!title || title === 'Match over') {
        throw new Error('game over title was not populated: ' + title);
    }
    if (scoreRows !== 2) {
        throw new Error('expected two score rows, found ' + scoreRows);
    }
    steps.push('gameEnd');

    // Return the room to the lobby from the results overlay.
    await click('returnToLobbyButton');
    await waitFor(
        `document.getElementById('gameOverOverlay').classList.contains('is-hidden')`,
        'overlay hidden after return'
    );
    await waitFor(
        `!document.getElementById('roomScreen').classList.contains('is-hidden')`,
        'room screen after return'
    );
    await waitFor(
        `document.getElementById('returnToLobbyButton').disabled === false`,
        'return button reset'
    );
    steps.push('returnToLobby');

    // Leave the room and log out.
    await click('leaveRoomButton');
    await waitFor(
        `!document.getElementById('lobbyScreen').classList.contains('is-hidden')`,
        'lobby after leave',
        30000
    );
    steps.push('leaveRoom');

    await click('logoutButton');
    await waitFor(
        `!document.getElementById('authScreen').classList.contains('is-hidden')`,
        'auth after logout',
        20000
    );
    steps.push('logout');

    // Continue as a guest and reach the lobby.
    await setInput('guestNameInput', guestName);
    await submit('guestForm');
    await waitFor(
        `!document.getElementById('lobbyScreen').classList.contains('is-hidden')`,
        'lobby as guest'
    );
    const guestIdentity = await js(`document.getElementById('lobbyIdentity').textContent`);
    if (guestIdentity.toLowerCase().indexOf('guest') === -1) {
        throw new Error('guest identity was not shown: ' + guestIdentity);
    }
    steps.push('guestLobby');

    // Legacy quick play still connects through the player handlers.
    await js('window.__uiGameUpdates = 0; true;');
    await click('quickPlayButton');
    await waitFor(
        `document.getElementById('gameAreaWrapper').classList.contains('is-active')`,
        'quick play game screen',
        20000
    );
    await waitFor('window.__uiGameUpdates > 0', 'quick play updates', 20000);
    steps.push('quickPlay');

    // Reloading returns to auth; the guest name is persisted. Quick spectate
    // uses the server's spectator handlers and never creates a cell.
    await win.webContents.reload();
    await waitFor(
        `!document.getElementById('authScreen').classList.contains('is-hidden')`,
        'auth after reload',
        30000
    );
    const persistedGuest = await js(`document.getElementById('guestNameInput').value`);
    if (persistedGuest !== guestName) {
        throw new Error('guest name was not persisted: ' + persistedGuest);
    }

    await js(`window.__uiSpectatorUpdates = 0;
        window.desktopTransport.on('serverTellPlayerMove', () => {
            window.__uiSpectatorUpdates += 1;
        });
        true;`);
    await click('spectateButton');
    await waitFor(
        `document.getElementById('gameAreaWrapper').classList.contains('is-active')`,
        'spectate game screen',
        20000
    );
    await waitFor(
        'window.__uiSpectatorUpdates > 0',
        'spectator updates',
        20000
    );
    steps.push('quickSpectate');

    if (rendererErrors.length > 0) {
        throw new Error('renderer errors: ' + rendererErrors.join(' | '));
    }

    return {
        ok: true,
        steps,
        account: username,
        second: secondUser,
        secondAccountId: auth.account.id,
        roomName,
        roomCode,
        title,
        scoreRows,
        guestIdentity
    };
}

app.whenReady().then(async () => {
    log('app ready');
    try {
        const result = await run();
        console.log('UI_E2E_RESULT ' + JSON.stringify(result));
        cleanup();
        app.exit(0);
    } catch (err) {
        console.error('UI_E2E_FAILURE', err && err.stack ? err.stack : err);
        cleanup();
        app.exit(1);
    }
});

function cleanup() {
    try {
        if (second) {
            second.disconnect('ui e2e complete');
        }
        if (bridge) {
            bridge.stop();
        }
    } catch (err) {
        console.error('[ui-e2e] cleanup error', err);
    }
}

app.on('window-all-closed', () => {
    // The test controls the lifecycle explicitly.
});
