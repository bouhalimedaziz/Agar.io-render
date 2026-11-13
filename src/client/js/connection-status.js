'use strict';

const BASE_CLASS = 'connection-status';

function formatDelay(delayMs) {
    const seconds = Math.max(1, Math.round((Number(delayMs) || 0) / 1000));
    return seconds + 's';
}

/**
 * Small DOM helper that renders the connection banner. It is deliberately
 * independent of the transport and Electron bridge so both clients share the
 * same states and it can be unit tested with a fake element.
 */
class ConnectionStatus {
    constructor(element) {
        if (!element || typeof element.setAttribute !== 'function') {
            throw new TypeError('A connection status element is required.');
        }

        this.element = element;
        this.state = 'idle';
        this.hidden = true;
        this._render('idle', '', true);
    }

    _render(state, message, hidden) {
        this.state = state;
        this.hidden = Boolean(hidden);
        this.element.textContent = message;
        this.element.className = BASE_CLASS + ' ' + BASE_CLASS + '--' + state +
            (hidden ? ' ' + BASE_CLASS + '--hidden' : '');
        this.element.setAttribute('aria-hidden', hidden ? 'true' : 'false');
        this.element.setAttribute('data-state', state);
    }

    connecting() {
        this._render('connecting', 'Connecting to the server…', false);
    }

    connected() {
        this._render('connected', '', true);
    }

    reconnecting(attempt, delayMs) {
        const tries = Number.isFinite(attempt) && attempt > 0
            ? ' (attempt ' + attempt + ')'
            : '';
        const wait = Number.isFinite(delayMs) && delayMs > 0
            ? ' in ' + formatDelay(delayMs)
            : '';
        this._render('reconnecting', 'Connection lost. Reconnecting' + wait + tries + '…', false);
    }

    disconnected() {
        this._render('reconnecting', 'Connection lost. Reconnecting…', false);
    }

    offline(message) {
        this._render('offline', message || 'Unable to reach the server. Retrying…', false);
    }

    shutdown() {
        this._render('shutdown', 'Server is shutting down. Refresh to reconnect.', false);
    }

    kicked(reason) {
        this._render('kicked', reason ? 'Kicked: ' + reason : 'You were kicked.', false);
    }
}

module.exports = ConnectionStatus;
