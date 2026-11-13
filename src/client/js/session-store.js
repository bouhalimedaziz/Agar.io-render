'use strict';

const STORAGE_KEY = 'openagar.session.v1';

const DEFAULT_STATE = Object.freeze({
    token: null,
    account: null,
    guestName: ''
});

function createMemoryStorage() {
    const values = new Map();
    return {
        getItem(key) {
            return values.has(key) ? values.get(key) : null;
        },
        setItem(key, value) {
            values.set(key, String(value));
        },
        removeItem(key) {
            values.delete(key);
        }
    };
}

function resolveStorage(storage) {
    if (storage && typeof storage.getItem === 'function') {
        return storage;
    }

    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            // Touch the API so private-mode browsers fall back to memory.
            window.localStorage.getItem(STORAGE_KEY);
            return window.localStorage;
        }
    } catch (err) {
        // localStorage can throw in sandboxed or private contexts.
    }

    return createMemoryStorage();
}

function normalizeAccount(account) {
    if (!account || typeof account !== 'object') {
        return null;
    }

    const id = Number(account.id);
    if (!Number.isInteger(id) || id <= 0 || typeof account.username !== 'string') {
        return null;
    }

    return {
        id,
        username: account.username,
        createdAt: account.createdAt === undefined ? null : account.createdAt,
        lastLoginAt: account.lastLoginAt === undefined ? null : account.lastLoginAt
    };
}

function normalizeGuestName(name) {
    if (typeof name !== 'string') {
        return '';
    }
    return name.trim().substring(0, 25);
}

/**
 * Persisted account session and guest display name.
 *
 * The account token is the only secret stored by the renderer. It is read on
 * startup and sent to the server with an `auth` event, which lets a reload
 * resume the session without asking for the password again.
 */
class SessionStore {
    constructor(options = {}) {
        this.key = options.key || STORAGE_KEY;
        this.storage = resolveStorage(options.storage);
        this.state = this._read();
    }

    _read() {
        let raw = null;
        try {
            raw = this.storage.getItem(this.key);
        } catch (err) {
            raw = null;
        }

        if (!raw) {
            return Object.assign({}, DEFAULT_STATE);
        }

        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            return Object.assign({}, DEFAULT_STATE);
        }

        return {
            token: typeof parsed.token === 'string' && parsed.token.length > 0
                ? parsed.token
                : null,
            account: normalizeAccount(parsed.account),
            guestName: normalizeGuestName(parsed.guestName)
        };
    }

    _persist() {
        try {
            this.storage.setItem(this.key, JSON.stringify(this.state));
        } catch (err) {
            // Persistence is best effort; the live session keeps working.
        }
    }

    get token() {
        return this.state.token;
    }

    get account() {
        return this.state.account;
    }

    get guestName() {
        return this.state.guestName;
    }

    get isAuthenticated() {
        return Boolean(this.state.token && this.state.account);
    }

    get displayName() {
        if (this.state.account) {
            return this.state.account.username;
        }
        return this.state.guestName || 'Guest';
    }

    setSession(session) {
        if (!session || typeof session !== 'object') {
            throw new TypeError('A session object is required.');
        }

        const token = typeof session.token === 'string' ? session.token : '';
        const account = normalizeAccount(session.account);
        if (!token || !account) {
            throw new TypeError('A valid token and account are required.');
        }

        this.state.token = token;
        this.state.account = account;
        this._persist();
        return this;
    }

    clearSession() {
        this.state.token = null;
        this.state.account = null;
        this._persist();
        return this;
    }

    setGuestName(name) {
        this.state.guestName = normalizeGuestName(name);
        this._persist();
        return this;
    }

    clearAll() {
        this.state = Object.assign({}, DEFAULT_STATE);
        this._persist();
        return this;
    }
}

function createSessionStore(options) {
    return new SessionStore(options);
}

module.exports = {
    STORAGE_KEY,
    SessionStore,
    createSessionStore,
    createMemoryStorage,
    normalizeGuestName
};
