'use strict';

/**
 * Transport-style facade over the Electron preload bridge. The rest of the
 * client can keep using `emit`/`on`/`close` without knowing that the TCP
 * connection lives in the main process.
 */

/**
 * Accept either a query string (`type=spectator`) or an object and reduce it
 * to the handshake fields the bridge understands.
 */
function normalizeQuery(query) {
    if (typeof query === 'string' && query.length > 0) {
        const parsed = {};
        const params = new URLSearchParams(query);
        params.forEach((value, key) => {
            parsed[key] = value;
        });
        return parsed;
    }
    if (query && typeof query === 'object') {
        return Object.assign({}, query);
    }
    return {};
}
class DesktopTransport {
    constructor(bridge, options = {}) {
        if (
            !bridge ||
            typeof bridge.emit !== 'function' ||
            typeof bridge.on !== 'function'
        ) {
            throw new TypeError('A desktop transport bridge is required.');
        }

        this.bridge = bridge;
        this.options = options || {};

        if (typeof bridge.connect === 'function') {
            bridge.connect({
                // The bridge whitelists `player`/`spectator`, so only the
                // handshake type is forwarded to the main process.
                query: normalizeQuery(this.options.query)
            });
        }
    }

    get connected() {
        if (typeof this.bridge.isConnected !== 'function') {
            return false;
        }
        return Boolean(this.bridge.isConnected());
    }

    emit(event, ...args) {
        if (typeof event !== 'string' || event.length === 0) {
            throw new TypeError('event must be a non-empty string');
        }

        this.bridge.emit(event, ...args);
        return this;
    }

    on(event, handler) {
        this.bridge.on(event, handler);
        return this;
    }

    once(event, handler) {
        const wrapped = (...args) => {
            this.off(event, wrapped);
            handler(...args);
        };
        return this.on(event, wrapped);
    }

    off(event, handler) {
        if (typeof this.bridge.off === 'function') {
            this.bridge.off(event, handler);
        } else if (typeof this.bridge.removeListener === 'function') {
            this.bridge.removeListener(event, handler);
        }
        return this;
    }

    removeListener(event, handler) {
        return this.off(event, handler);
    }

    close() {
        if (typeof this.bridge.disconnect === 'function') {
            this.bridge.disconnect();
        }
        return this;
    }

    disconnect() {
        return this.close();
    }
}

function createDesktopTransport(bridge, options) {
    return new DesktopTransport(bridge, options);
}

module.exports = {
    DesktopTransport,
    createDesktopTransport,
    normalizeQuery
};
