'use strict';

const { AUTH_ERROR_CODES, AuthError } = require('./errors');
const { AttemptRateLimiter } = require('./rate-limiter');
const { AuthService, createAuthService, publicAccount, DEFAULT_AUTH_CONFIG } = require('./auth-service');
const { hashPassword, verifyPassword } = require('./password');

module.exports = {
    AUTH_ERROR_CODES,
    AuthError,
    AttemptRateLimiter,
    AuthService,
    createAuthService,
    publicAccount,
    DEFAULT_AUTH_CONFIG,
    hashPassword,
    verifyPassword
};
