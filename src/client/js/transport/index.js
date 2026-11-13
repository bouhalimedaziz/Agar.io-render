'use strict';

function getDesktopBridge() {
    if (typeof window === 'undefined') {
        return null;
    }
    return window.desktopTransport || null;
}

/**
 * Two ways to reach the server:
 *  - Electron desktop client: the preload exposes `window.desktopTransport` and
 *    the main process owns a raw TCP socket (the TCP version of the game).
 *  - Plain browser (e.g. the publicly hosted server): browsers cannot open raw
 *    TCP sockets, so we use a WebSocket to /game on the page's own host.
 * Both expose the same bridge interface, so the game code is identical.
 */
function createTransport(options = {}) {
    const { createDesktopTransport } = require('./desktop-transport');
    const bridge = getDesktopBridge();
    if (bridge) {
        return createDesktopTransport(bridge, options);
    }

    const { createWebBridge } = require('./web-bridge');
    return createDesktopTransport(createWebBridge(), options);
}

module.exports = {
    createTransport
};
