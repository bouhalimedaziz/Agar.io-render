module.exports = {
    host: "0.0.0.0",
    port: 3000,
    tcp: {
        enabled: true,
        host: "0.0.0.0",
        port: 3001,
        heartbeatInterval: 1000,
        heartbeatTimeout: 3000,
        maxPayloadSize: 1024 * 1024,
        handshakeTimeout: 5000
    },
    // WebSocket transport (cross-network bonus): served on the HTTP port above.
    ws: {
        enabled: true,
        path: "/game",
        heartbeatInterval: 1000,
        heartbeatTimeout: 5000
    },
    auth: {
        sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
        usernameMinLength: 3,
        usernameMaxLength: 20,
        passwordMinLength: 8,
        passwordMaxLength: 128,
        // "replace" disconnects the older session on a new login.
        // "reject" refuses the new login while another session is active.
        duplicateLogin: "replace",
        allowGuests: true,
        rateLimit: {
            windowMs: 60 * 1000,
            maxAttempts: 5,
            registerMaxAttempts: 10,
            ipMaxAttempts: 20
        }
    },
    rooms: {
        emptyRoomGraceMs: 5 * 60 * 1000,
        disconnectGraceMs: 2 * 60 * 1000,
        cleanupIntervalMs: 60 * 1000,
        maxRooms: 200,
        defaultMaxPlayers: 8,
        defaultTimeLimitMs: 0,
        defaultScoreLimit: 0
    },
    game: {
        countdownMs: 3000,
        minPlayers: 2
    },
    logpath: "logger.php",
    foodMass: 1,
    fireFood: 20,
    limitSplit: 16,
    defaultPlayerMass: 10,
	virus: {
        fill: "#33ff33",
        stroke: "#19D119",
        strokeWidth: 20,
        defaultMass: {
            from: 100,
            to: 150
        },
        splitMass: 180,
        uniformDisposition: false,
	},
    gameWidth: 5000,
    gameHeight: 5000,
    adminPass: "DEFAULT",
    gameMass: 20000,
    maxFood: 1000,
    maxVirus: 50,
    slowBase: 4.5,
    logChat: 0,
    networkUpdateFactor: 40,
    maxHeartbeatInterval: 5000,
    foodUniformDisposition: true,
    newPlayerInitialPosition: "farthest",
    massLossRate: 1,
    minMassLoss: 50,
    sqlinfo: {
      fileName: "db.sqlite3",
    }
};
