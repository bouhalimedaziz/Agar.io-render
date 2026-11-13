'use strict';

/**
 * Browser transport: a WebSocket to the game server's /game endpoint.
 *
 * It exposes the same interface as the Electron preload bridge
 * (window.desktopTransport), so the rest of the client does not change:
 *   connect(options), disconnect(), emit(event, ...args), on/once/off,
 *   getState(), isConnected()
 * and it reports the same lifecycle events as the TCP client:
 *   connect, disconnect, connect_error, reconnecting, reconnect_failed
 *
 * Used when the client page is opened in a normal browser (no Electron), which
 * is how players on other networks join the publicly hosted server.
 */

const HEARTBEAT_EVENT = '__hb';
const HEARTBEAT_ACK_EVENT = '__hb_ack';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 5000;
const MAX_RECONNECT_ATTEMPTS = 20;
// The server pings every second; if nothing at all arrives for this long the
// connection is considered dead even if the browser has not noticed yet.
const SILENCE_TIMEOUT_MS = 6000;

function defaultUrl(query) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams(query || {}).toString();
    return proto + '//' + window.location.host + '/game' + (params ? '?' + params : '');
}

function createWebBridge(options = {}) {
    const listeners = new Map();
    const queue = [];
    let ws = null;
    let state = 'disconnected';
    let query = {};
    let manualClose = false;
    let attempts = 0;
    let reconnectTimer = null;
    let silenceTimer = null;
    let everConnected = false;

    function dispatch(event, args) {
        const handlers = listeners.get(event);
        if (!handlers) {
            return;
        }
        for (const handler of Array.from(handlers)) {
            try {
                handler(...args);
            } catch (err) {
                console.error('[TRANSPORT] Event listener failed:', err);
            }
        }
    }

    function armSilenceTimer() {
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
            if (ws) {
                ws.close(4000, 'heartbeat timeout');
                handleClose('heartbeat timeout');
            }
        }, SILENCE_TIMEOUT_MS);
    }

    function send(event, args) {
        ws.send(JSON.stringify({ event, args }));
    }

    function handleClose(reason) {
        if (!ws) {
            return;
        }
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        ws = null;
        clearTimeout(silenceTimer);
        const wasConnected = state === 'connected';
        state = 'disconnected';
        if (wasConnected) {
            dispatch('disconnect', [reason]);
        }
        if (!manualClose) {
            scheduleReconnect();
        }
    }

    function scheduleReconnect() {
        if (attempts >= MAX_RECONNECT_ATTEMPTS) {
            dispatch('reconnect_failed', []);
            return;
        }
        const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, attempts));
        attempts += 1;
        state = 'reconnecting';
        dispatch('reconnecting', [attempts, delay]);
        reconnectTimer = setTimeout(open, delay);
    }

    function open() {
        state = 'connecting';
        let socket;
        try {
            socket = new WebSocket(options.url || defaultUrl(query));
        } catch (err) {
            dispatch('connect_error', [{ name: err.name, message: err.message }]);
            scheduleReconnect();
            return;
        }
        ws = socket;

        socket.onopen = () => {
            state = 'connected';
            attempts = 0;
            everConnected = true;
            armSilenceTimer();
            // flush events emitted while (re)connecting, like the TCP client does
            while (queue.length && state === 'connected') {
                const item = queue.shift();
                send(item.event, item.args);
            }
            dispatch('connect', []);
        };

        socket.onmessage = (msg) => {
            armSilenceTimer();
            let data;
            try {
                data = JSON.parse(msg.data);
            } catch (err) {
                return;
            }
            if (!data || typeof data.event !== 'string') {
                return;
            }
            const args = Array.isArray(data.args) ? data.args : [];
            if (data.event === HEARTBEAT_EVENT) {
                send(HEARTBEAT_ACK_EVENT, args);
                return;
            }
            dispatch(data.event, args);
        };

        socket.onerror = () => {
            if (!everConnected && state === 'connecting') {
                dispatch('connect_error', [{ name: 'Error', message: 'Could not reach the game server.' }]);
            }
        };

        socket.onclose = (event) => {
            handleClose(event.reason || ('closed (' + event.code + ')'));
        };
    }

    const api = {
        connect(connectOptions) {
            query = (connectOptions && connectOptions.query) || {};
            manualClose = false;
            attempts = 0;
            clearTimeout(reconnectTimer);
            if (ws) {
                return;
            }
            open();
        },

        disconnect() {
            manualClose = true;
            clearTimeout(reconnectTimer);
            if (ws) {
                const socket = ws;
                // 1000 = normal closure: the server treats it as a deliberate quit
                socket.close(1000, 'client disconnect');
                handleClose('client disconnect');
            }
            state = 'disconnected';
        },

        emit(event, ...args) {
            if (typeof event !== 'string' || event.length === 0) {
                throw new TypeError('event must be a non-empty string');
            }
            if (ws && state === 'connected') {
                send(event, args);
            } else {
                queue.push({ event, args });
            }
        },

        on(event, handler) {
            if (!listeners.has(event)) {
                listeners.set(event, []);
            }
            listeners.get(event).push(handler);
        },

        once(event, handler) {
            const wrapped = (...args) => {
                api.off(event, wrapped);
                handler(...args);
            };
            api.on(event, wrapped);
        },

        off(event, handler) {
            const handlers = listeners.get(event);
            if (!handlers) {
                return;
            }
            listeners.set(event, handlers.filter((entry) => entry !== handler));
        },

        removeListener(event, handler) {
            api.off(event, handler);
        },

        getState() {
            return { connected: state === 'connected', state, transport: 'websocket' };
        },

        isConnected() {
            return state === 'connected';
        }
    };

    return api;
}

module.exports = {
    createWebBridge,
    HEARTBEAT_EVENT,
    HEARTBEAT_ACK_EVENT
};
