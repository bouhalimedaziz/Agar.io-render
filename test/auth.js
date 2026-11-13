'use strict';

const expect = require('chai').expect;

const { createDatabase, initializeSchema } = require('../src/server/database');
const { createAccountRepository } = require('../src/server/repositories/account-repository');
const { createSessionRepository } = require('../src/server/repositories/session-repository');
const {
    createAuthService,
    AuthError,
    AUTH_ERROR_CODES,
    hashPassword,
    verifyPassword
} = require('../src/server/auth');

const BASE_CONFIG = {
    sessionTtlMs: 60 * 60 * 1000,
    usernameMinLength: 3,
    usernameMaxLength: 20,
    passwordMinLength: 8,
    passwordMaxLength: 128,
    duplicateLogin: 'replace',
    rateLimit: {
        windowMs: 60 * 1000,
        maxAttempts: 5,
        registerMaxAttempts: 100,
        ipMaxAttempts: 100
    }
};

async function expectAuthError(promise, code) {
    try {
        await promise;
    } catch (err) {
        expect(err).to.be.instanceOf(AuthError);
        expect(err.code).to.equal(code);
        return err;
    }

    throw new Error('Expected auth error ' + code);
}

describe('auth', () => {
    describe('password hashing', () => {
        it('stores a self-describing salt and verifies the password', async () => {
            const encoded = await hashPassword('correct horse battery staple');

            expect(encoded).to.match(/^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]+\$[0-9a-f]+$/);
            expect(encoded).to.not.contain('correct horse battery staple');
            expect(await verifyPassword('correct horse battery staple', encoded)).to.equal(true);
            expect(await verifyPassword('wrong password', encoded)).to.equal(false);
        });

        it('uses a fresh salt for every hash', async () => {
            const first = await hashPassword('same password');
            const second = await hashPassword('same password');

            expect(first).to.not.equal(second);
            expect(await verifyPassword('same password', first)).to.equal(true);
            expect(await verifyPassword('same password', second)).to.equal(true);
        });

        it('rejects malformed hashes instead of throwing', async () => {
            expect(await verifyPassword('password', 'not-a-hash')).to.equal(false);
            expect(await verifyPassword('password', null)).to.equal(false);
            expect(await verifyPassword(undefined, 'not-a-hash')).to.equal(false);
        });
    });

    describe('AuthService', () => {
        let db;
        let auth;
        let clock;
        let loggingCalls;
        let tokenCounter;

        function makeAuth(overrides = {}) {
            const config = Object.assign({}, BASE_CONFIG, overrides);
            if (overrides.rateLimit) {
                config.rateLimit = Object.assign({}, BASE_CONFIG.rateLimit, overrides.rateLimit);
            }

            return createAuthService({
                accountRepository: createAccountRepository(db),
                sessionRepository: createSessionRepository(db),
                loggingRepository: {
                    logFailedLoginAttempt: async (username, ipAddress) => {
                        loggingCalls.push({ username, ipAddress });
                    }
                },
                config,
                now: () => clock,
                tokenGenerator: () => `token-${++tokenCounter}`
            });
        }

        beforeEach(async () => {
            clock = 1000 * 1000;
            loggingCalls = [];
            tokenCounter = 0;
            db = createDatabase(':memory:');
            await initializeSchema(db);
            auth = makeAuth();
        });

        afterEach((done) => {
            db.close(done);
        });

        it('registers an account and returns a session token', async () => {
            const result = await auth.register(
                { username: 'Alice_1', password: 'password123' },
                '10.0.0.1'
            );

            expect(result.account.id).to.be.a('number');
            expect(result.account.username).to.equal('Alice_1');
            expect(result.account.passwordHash).to.equal(undefined);
            expect(result.token).to.equal('token-1');
            expect(result.expiresAt).to.equal(clock + BASE_CONFIG.sessionTtlMs);

            const stored = await createAccountRepository(db)
                .findByNormalizedUsername('alice_1');
            expect(stored.username).to.equal('Alice_1');
            expect(stored.passwordHash).to.not.contain('password123');
        });

        it('rejects usernames that differ only by case', async () => {
            await auth.register({ username: 'Alice', password: 'password123' }, '10.0.0.1');

            await expectAuthError(
                auth.register({ username: 'alice', password: 'password123' }, '10.0.0.1'),
                AUTH_ERROR_CODES.USERNAME_TAKEN
            );
        });

        it('validates username and password rules', async () => {
            await expectAuthError(
                auth.register({ username: 'a', password: 'password123' }, '10.0.0.1'),
                AUTH_ERROR_CODES.INVALID_USERNAME
            );
            await expectAuthError(
                auth.register({ username: 'has space', password: 'password123' }, '10.0.0.1'),
                AUTH_ERROR_CODES.INVALID_USERNAME
            );
            await expectAuthError(
                auth.register({ username: 'validname', password: 'short' }, '10.0.0.1'),
                AUTH_ERROR_CODES.INVALID_PASSWORD
            );
        });

        it('logs in with valid credentials', async () => {
            const registered = await auth.register(
                { username: 'Bob', password: 'password123' },
                '10.0.0.1'
            );
            await auth.logout(registered.token);

            clock += 5000;
            const result = await auth.login(
                { username: 'bob', password: 'password123' },
                '10.0.0.1'
            );

            expect(result.account.username).to.equal('Bob');
            expect(result.account.lastLoginAt).to.equal(clock);
            expect(result.revokedTokens).to.deep.equal([]);

            const resumed = await auth.resumeSession(result.token);
            expect(resumed.account.id).to.equal(registered.account.id);
        });

        it('rejects invalid credentials and records the failure', async () => {
            await auth.register({ username: 'Carol', password: 'password123' }, '10.0.0.1');

            await expectAuthError(
                auth.login({ username: 'Carol', password: 'wrongpass' }, '10.0.0.1'),
                AUTH_ERROR_CODES.INVALID_CREDENTIALS
            );
            await expectAuthError(
                auth.login({ username: 'nobody', password: 'password123' }, '10.0.0.1'),
                AUTH_ERROR_CODES.INVALID_CREDENTIALS
            );

            expect(loggingCalls).to.deep.equal([
                { username: 'Carol', ipAddress: '10.0.0.1' },
                { username: 'nobody', ipAddress: '10.0.0.1' }
            ]);
            expect(JSON.stringify(loggingCalls)).to.not.contain('wrongpass');
        });

        it('replaces older sessions on a new login', async () => {
            const first = await auth.register(
                { username: 'Dave', password: 'password123' },
                '10.0.0.1'
            );
            const second = await auth.login(
                { username: 'Dave', password: 'password123' },
                '10.0.0.2'
            );

            expect(second.revokedTokens).to.deep.equal([first.token]);
            await expectAuthError(
                auth.resumeSession(first.token),
                AUTH_ERROR_CODES.INVALID_SESSION
            );
            const resumed = await auth.resumeSession(second.token);
            expect(resumed.account.username).to.equal('Dave');
        });

        it('can reject duplicate logins instead of replacing sessions', async () => {
            const rejectAuth = makeAuth({ duplicateLogin: 'reject' });
            const first = await rejectAuth.register(
                { username: 'Erin', password: 'password123' },
                '10.0.0.1'
            );

            await expectAuthError(
                rejectAuth.login({ username: 'Erin', password: 'password123' }, '10.0.0.2'),
                AUTH_ERROR_CODES.DUPLICATE_LOGIN
            );

            const resumed = await rejectAuth.resumeSession(first.token);
            expect(resumed.account.username).to.equal('Erin');
        });

        it('resumes a session and tracks the disconnect state', async () => {
            const registered = await auth.register(
                { username: 'Frank', password: 'password123' },
                '10.0.0.1'
            );

            expect(await auth.markDisconnected(registered.token)).to.equal(true);

            let stored = await createSessionRepository(db).findByToken(registered.token);
            expect(stored.state).to.equal('disconnected');

            const resumed = await auth.resumeSession(registered.token);
            expect(resumed.session.state).to.equal('active');
            expect(resumed.account.username).to.equal('Frank');

            stored = await createSessionRepository(db).findByToken(registered.token);
            expect(stored.state).to.equal('active');
        });

        it('expires sessions and refuses to resume them', async () => {
            const registered = await auth.register(
                { username: 'Grace', password: 'password123' },
                '10.0.0.1'
            );

            clock += BASE_CONFIG.sessionTtlMs + 1;

            await expectAuthError(
                auth.resumeSession(registered.token),
                AUTH_ERROR_CODES.SESSION_EXPIRED
            );

            const stored = await createSessionRepository(db).findByToken(registered.token);
            expect(stored).to.equal(null);
        });

        it('invalidates a session on logout', async () => {
            const registered = await auth.register(
                { username: 'Heidi', password: 'password123' },
                '10.0.0.1'
            );

            expect(await auth.logout(registered.token)).to.equal(true);
            expect(await auth.logout(registered.token)).to.equal(false);

            await expectAuthError(
                auth.resumeSession(registered.token),
                AUTH_ERROR_CODES.INVALID_SESSION
            );
        });

        it('rate limits repeated login failures', async () => {
            const limitedAuth = makeAuth({ rateLimit: { maxAttempts: 2 } });
            const registered = await limitedAuth.register(
                { username: 'Ivan', password: 'password123' },
                '10.0.0.1'
            );
            await limitedAuth.logout(registered.token);

            await expectAuthError(
                limitedAuth.login({ username: 'Ivan', password: 'wrongpass' }, '10.0.0.1'),
                AUTH_ERROR_CODES.INVALID_CREDENTIALS
            );
            await expectAuthError(
                limitedAuth.login({ username: 'Ivan', password: 'wrongpass' }, '10.0.0.1'),
                AUTH_ERROR_CODES.INVALID_CREDENTIALS
            );

            const blocked = await expectAuthError(
                limitedAuth.login({ username: 'Ivan', password: 'password123' }, '10.0.0.1'),
                AUTH_ERROR_CODES.RATE_LIMITED
            );
            expect(blocked.details.retryAfterMs).to.be.above(0);

            clock += BASE_CONFIG.rateLimit.windowMs + 1;
            const result = await limitedAuth.login(
                { username: 'Ivan', password: 'password123' },
                '10.0.0.1'
            );
            expect(result.token).to.be.a('string');
        });

        it('rate limits repeated registration attempts per IP', async () => {
            const limitedAuth = makeAuth({ rateLimit: { registerMaxAttempts: 2 } });

            await limitedAuth.register(
                { username: 'Judy1', password: 'password123' },
                '10.0.0.9'
            );
            await limitedAuth.register(
                { username: 'Judy2', password: 'password123' },
                '10.0.0.9'
            );

            await expectAuthError(
                limitedAuth.register(
                    { username: 'Judy3', password: 'password123' },
                    '10.0.0.9'
                ),
                AUTH_ERROR_CODES.RATE_LIMITED
            );
        });

        it('cleans up expired sessions', async () => {
            await auth.register({ username: 'Kevin', password: 'password123' }, '10.0.0.1');
            clock += BASE_CONFIG.sessionTtlMs + 1;
            await auth.register({ username: 'Laura', password: 'password123' }, '10.0.0.2');

            const removed = await auth.cleanupExpiredSessions();
            expect(removed).to.equal(1);

            const sessions = await new Promise((resolve, reject) => {
                db.all('SELECT token FROM sessions', [], (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows);
                });
            });
            expect(sessions).to.have.length(1);
        });
    });
});
