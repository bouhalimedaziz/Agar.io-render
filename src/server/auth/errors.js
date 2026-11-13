'use strict';

const AUTH_ERROR_CODES = Object.freeze({
    INVALID_INPUT: 'invalid_input',
    INVALID_USERNAME: 'invalid_username',
    INVALID_PASSWORD: 'invalid_password',
    USERNAME_TAKEN: 'username_taken',
    INVALID_CREDENTIALS: 'invalid_credentials',
    RATE_LIMITED: 'rate_limited',
    INVALID_SESSION: 'invalid_session',
    SESSION_EXPIRED: 'session_expired',
    DUPLICATE_LOGIN: 'duplicate_login',
    SESSION_REPLACED: 'session_replaced',
    INTERNAL_ERROR: 'internal_error'
});

/**
 * Error that is safe to serialize to a client. Messages never contain
 * passwords or tokens.
 */
class AuthError extends Error {
    constructor(code, message, details) {
        super(message);
        this.name = 'AuthError';
        this.code = code;
        if (details !== undefined) {
            this.details = details;
        }
    }

    toPayload() {
        const payload = { code: this.code, message: this.message };
        if (this.details !== undefined) {
            payload.details = this.details;
        }
        return payload;
    }
}

module.exports = {
    AUTH_ERROR_CODES,
    AuthError
};
