'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Keep these names in sync with src/electron/tcp-bridge.js. The preload is
// sandboxed, so it cannot require the shared module.
const CHANNELS = Object.freeze({
    CONNECT: 'agar:transport:connect',
    DISCONNECT: 'agar:transport:disconnect',
    EMIT: 'agar:transport:emit',
    STATE: 'agar:transport:state',
    EVENT: 'agar:transport:event'
});

const listeners = new Map();

function addListener(event, handler) {
    if (typeof event !== 'string' || event.length === 0) {
        throw new TypeError('event must be a non-empty string');
    }
    if (typeof handler !== 'function') {
        throw new TypeError('handler must be a function');
    }
    if (!listeners.has(event)) {
        listeners.set(event, []);
    }
    listeners.get(event).push(handler);
}

function removeListener(event, handler) {
    const handlers = listeners.get(event);
    if (!handlers) {
        return;
    }

    const remaining = handlers.filter((entry) => entry !== handler);
    if (remaining.length === 0) {
        listeners.delete(event);
    } else {
        listeners.set(event, remaining);
    }
}

ipcRenderer.on(CHANNELS.EVENT, (_event, message) => {
    if (!message || typeof message.event !== 'string') {
        return;
    }

    const handlers = listeners.get(message.event);
    if (!handlers) {
        return;
    }

    const args = Array.isArray(message.args) ? message.args : [];
    for (const handler of Array.from(handlers)) {
        try {
            handler(...args);
        } catch (err) {
            console.error('[TRANSPORT] Event listener failed:', err);
        }
    }
});

const api = {
    connect(options) {
        ipcRenderer.send(CHANNELS.CONNECT, options || {});
    },

    disconnect() {
        ipcRenderer.send(CHANNELS.DISCONNECT);
    },

    emit(event, ...args) {
        if (typeof event !== 'string' || event.length === 0) {
            throw new TypeError('event must be a non-empty string');
        }
        ipcRenderer.send(CHANNELS.EMIT, { event, args });
    },

    on(event, handler) {
        addListener(event, handler);
    },

    once(event, handler) {
        const wrapped = (...args) => {
            removeListener(event, wrapped);
            handler(...args);
        };
        addListener(event, wrapped);
    },

    off(event, handler) {
        removeListener(event, handler);
    },

    removeListener(event, handler) {
        removeListener(event, handler);
    },

    getState() {
        const state = ipcRenderer.sendSync(CHANNELS.STATE);
        if (!state || typeof state !== 'object') {
            return { connected: false, state: 'unknown' };
        }
        return state;
    },

    isConnected() {
        return Boolean(api.getState().connected);
    }
};

contextBridge.exposeInMainWorld('desktopTransport', api);
