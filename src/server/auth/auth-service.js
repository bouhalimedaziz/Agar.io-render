'use strict';

const crypto = require('crypto');

const util = require('../lib/util');
const { AUTH_ERROR_CODES, AuthError } = require('./errors');
const { AttemptRateLimiter } = require('./rate-limiter');
const passwordHash = require('./password');

const DEFAULT_AUTH_CONFIG = Object.freeze({
    sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
    usernameMinLength: 3,
    usernameMaxLength: 20,
    passwordMinLength: 8,
    passwordMaxLength: 128,
    duplicateLogin: 'replace',
    rateLimit: {
        windowMs: 60 * 1000,
        maxAttempts: 5,
        registerMaxAttempts: 10,
        ipMaxAttempts: 20
    }
});

function mergeConfig(config) {
    const merged = Object.assign({}, DEFAULT_AUTH_CONFIG, config || {});
    merged.rateLimit = Object.assign(
        {},
        DEFAULT_AUTH_CONFIG.rateLimit,
        (config && config.rateLimit) || {}
    );
    return merged;
}

function publicAccount(account) {
    if (!account) {
        return null;
    }

    return {
        id: account.id,
        username: account.username,
        createdAt: account.createdAt,
        lastLoginAt: account.lastLoginAt === undefined ? null : account.lastLoginAt
    };
}

/**
 * Account/session logic, independent from the transport.
 *
 * The server supplies SQLite-backed repositories, while tests can use the
 * same repositories against an in-memory database.
 */
class AuthService {
    constructor(options = {}) {
        if (!options.accountRepository || !options.sessionRepository) {
            throw new TypeError('accountRepository and sessionRepository are required');
        }

        this.accounts = options.accountRepository;
        this.sessions = options.sessionRepository;
        this.logging = options.loggingRepository || null;
        this.config = mergeConfig(options.config);
        this.now = typeof options.now === 'function' ? options.now : Date.now;
        this.tokenGenerator = typeof options.tokenGenerator === 'function'
            ? options.tokenGenerator
            : () => crypto.randomBytes(32).toString('hex');
        this.passwordHasher = options.passwordHasher || passwordHash;

        const rateLimit = this.config.rateLimit;
        this.userLimiter = new AttemptRateLimiter({
            maxAttempts: rateLimit.maxAttempts,
            windowMs: rateLimit.windowMs,
            now: this.now
        });
        this.ipLimiter = new AttemptRateLimiter({
            maxAttempts: rateLimit.ipMaxAttempts,
            windowMs: rateLimit.windowMs,
            now: this.now
        });
        this.registerLimiter = new AttemptRateLimiter({
            maxAttempts: rateLimit.registerMaxAttempts,
            windowMs: rateLimit.windowMs,
            now: this.now
        });
    }

    _validateUsername(rawUsername) {
        if (typeof rawUsername !== 'string') {
            throw new AuthError(AUTH_ERROR_CODES.INVALID_USERNAME, 'Username is required.');
        }

        const username = rawUsername.trim();
        const { usernameMinLength, usernameMaxLength } = this.config;

        if (username.length < usernameMinLength || username.length > usernameMaxLength) {
            throw new AuthError(
                AUTH_ERROR_CODES.INVALID_USERNAME,
                `Username must be ${usernameMinLength}-${usernameMaxLength} characters.`
            );
        }

        if (!util.validNick(username)) {
            throw new AuthError(
                AUTH_ERROR_CODES.INVALID_USERNAME,
                'Username may only contain letters, numbers and underscores.'
            );
        }

        return username;
    }

    _validatePassword(password) {
        if (typeof password !== 'string') {
            throw new AuthError(AUTH_ERROR_CODES.INVALID_PASSWORD, 'Password is required.');
        }

        const { passwordMinLength, passwordMaxLength } = this.config;

        if (password.length < passwordMinLength || password.length > passwordMaxLength) {
            throw new AuthError(
                AUTH_ERROR_CODES.INVALID_PASSWORD,
                `Password must be ${passwordMinLength}-${passwordMaxLength} characters.`
            );
        }

        return password;
    }

    _assertAllowed(limiter, key) {
        const result = limiter.check(key);
        if (!result.allowed) {
            throw new AuthError(
                AUTH_ERROR_CODES.RATE_LIMITED,
                'Too many attempts. Please try again later.',
                { retryAfterMs: result.retryAfterMs }
            );
        }
    }

    _recordFailure(limiter, key) {
        limiter.record(key);
    }

    async _logFailedAttempt(username, ipAddress) {
        if (!this.logging || typeof this.logging.logFailedLoginAttempt !== 'function') {
            return;
        }

        try {
            await this.logging.logFailedLoginAttempt(username, ipAddress);
        } catch (err) {
            // Logging must never block authentication.
        }
    }

    async _createSession(accountId) {
        const now = this.now();
        let lastError = null;

        for (let attempt = 0; attempt < 3; attempt += 1) {
            const token = this.tokenGenerator();
            try {
                return await this.sessions.create({
                    token,
                    accountId,
                    createdAt: now,
                    expiresAt: now + this.config.sessionTtlMs,
                    lastSeenAt: now
                });
            } catch (err) {
                lastError = err;
            }
        }

        throw lastError;
    }

    async register(input = {}, ipAddress = 'unknown') {
        const registerKey = ipAddress || 'unknown';
        this._assertAllowed(this.registerLimiter, registerKey);
        this._recordFailure(this.registerLimiter, registerKey);

        const username = this._validateUsername(input.username);
        const password = this._validatePassword(input.password);
        const normalizedUsername = username.toLowerCase();

        const existing = await this.accounts.findByNormalizedUsername(normalizedUsername);
        if (existing) {
            throw new AuthError(AUTH_ERROR_CODES.USERNAME_TAKEN, 'That username is already taken.');
        }

        const hash = await this.passwordHasher.hashPassword(password);

        let account;
        try {
            account = await this.accounts.create({
                username,
                normalizedUsername,
                passwordHash: hash,
                createdAt: this.now()
            });
        } catch (err) {
            // A concurrent registration can win the unique-index race.
            if (err && /UNIQUE/i.test(String(err.message))) {
                throw new AuthError(AUTH_ERROR_CODES.USERNAME_TAKEN, 'That username is already taken.');
            }
            throw err;
        }

        const session = await this._createSession(account.id);

        return {
            account: publicAccount(account),
            token: session.token,
            expiresAt: session.expiresAt
        };
    }

    async login(input = {}, ipAddress = 'unknown') {
        const ip = ipAddress || 'unknown';
        const rawUsername = typeof input.username === 'string' ? input.username.trim() : '';
        const normalizedUsername = rawUsername.toLowerCase();
        const password = input.password;

        const ipKey = `ip:${ip}`;
        const userKey = `user:${ip}:${normalizedUsername}`;

        this._assertAllowed(this.ipLimiter, ipKey);
        this._assertAllowed(this.userLimiter, userKey);

        if (!rawUsername || typeof password !== 'string') {
            this._recordFailure(this.ipLimiter, ipKey);
            this._recordFailure(this.userLimiter, userKey);
            await this._logFailedAttempt(rawUsername, ip);
            throw new AuthError(
                AUTH_ERROR_CODES.INVALID_CREDENTIALS,
                'Invalid username or password.'
            );
        }

        const account = await this.accounts.findByNormalizedUsername(normalizedUsername);
        const valid = account
            ? await this.passwordHasher.verifyPassword(password, account.passwordHash)
            : false;

        if (!valid) {
            this._recordFailure(this.ipLimiter, ipKey);
            this._recordFailure(this.userLimiter, userKey);
            await this._logFailedAttempt(rawUsername, ip);
            throw new AuthError(
                AUTH_ERROR_CODES.INVALID_CREDENTIALS,
                'Invalid username or password.'
            );
        }

        this.userLimiter.reset(userKey);

        const now = this.now();

        if (this.config.duplicateLogin === 'reject') {
            const active = await this.sessions.findActiveByAccountId(account.id, now);
            if (active.length > 0) {
                throw new AuthError(
                    AUTH_ERROR_CODES.DUPLICATE_LOGIN,
                    'This account is already logged in.'
                );
            }
        }

        await this.accounts.updateLastLogin(account.id, now);

        const session = await this._createSession(account.id);
        let revokedTokens = [];

        if (this.config.duplicateLogin === 'replace') {
            revokedTokens = await this.sessions.deleteByAccountId(account.id, session.token);
        }

        return {
            account: publicAccount(Object.assign({}, account, { lastLoginAt: now })),
            token: session.token,
            expiresAt: session.expiresAt,
            revokedTokens
        };
    }

    async resumeSession(token) {
        if (typeof token !== 'string' || token.length === 0) {
            throw new AuthError(AUTH_ERROR_CODES.INVALID_SESSION, 'A session token is required.');
        }

        const session = await this.sessions.findByToken(token);
        if (!session) {
            throw new AuthError(AUTH_ERROR_CODES.INVALID_SESSION, 'Session is not valid.');
        }

        const now = this.now();
        if (session.expiresAt <= now) {
            await this.sessions.deleteByToken(token);
            throw new AuthError(AUTH_ERROR_CODES.SESSION_EXPIRED, 'Session has expired.');
        }

        const account = await this.accounts.findById(session.accountId);
        if (!account) {
            await this.sessions.deleteByToken(token);
            throw new AuthError(AUTH_ERROR_CODES.INVALID_SESSION, 'Session is not valid.');
        }

        await this.sessions.markActive(token, now);

        return {
            account: publicAccount(account),
            session: Object.assign({}, session, { lastSeenAt: now, state: 'active' })
        };
    }

    async logout(token) {
        if (typeof token !== 'string' || token.length === 0) {
            return false;
        }
        return this.sessions.deleteByToken(token);
    }

    async markDisconnected(token) {
        if (typeof token !== 'string' || token.length === 0) {
            return false;
        }
        return this.sessions.markDisconnected(token, this.now());
    }

    cleanupExpiredSessions() {
        return this.sessions.deleteExpired(this.now());
    }
}

function createAuthService(options) {
    return new AuthService(options);
}

module.exports = {
    AuthService,
    createAuthService,
    publicAccount,
    DEFAULT_AUTH_CONFIG
};
