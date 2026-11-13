'use strict';

const SAT = require('sat');

const util = require('../lib/util');
const mapUtils = require('../map/map');
const {
    DEFAULT_VIEW_WIDTH,
    DEFAULT_VIEW_HEIGHT,
    normalizeScreenSize,
    normalizeTarget
} = require('./validation');
const {
    normalizeWeights,
    scorePlayer,
    rankPlayers
} = require('./scoring');

const DEFAULT_GAME_SETTINGS = Object.freeze({
    mapWidth: 5000,
    mapHeight: 5000,
    maxFood: 1000,
    maxVirus: 50,
    foodMass: 1,
    defaultPlayerMass: 10,
    gameMass: 20000,
    maxPlayers: 8,
    timeLimitMs: 0,
    scoreLimit: 0
});

const DEFAULT_GAME_OPTIONS = Object.freeze({
    networkUpdateFactor: 40,
    slowBase: 4.5,
    limitSplit: 16,
    fireFood: 20,
    massLossRate: 1,
    minMassLoss: 50,
    maxHeartbeatInterval: 5000,
    newPlayerInitialPosition: 'farthest',
    // Minimum time between repeated actions, in milliseconds. These keep a
    // client from flooding the server with split/fire requests.
    fireFoodCooldownMs: 100,
    splitCooldownMs: 250
});

const Vector = SAT.Vector;

function noop() {}

/**
 * One isolated game world.
 *
 * A session owns its own Map, players, leaderboard, timers and state. Room
 * sessions are created by RoomLobby; the server also creates one "default"
 * session for clients that have not joined a room yet, which keeps the current
 * browser client working.
 */
class GameSession {
    constructor(options = {}) {
        this.roomId = options.roomId === undefined ? null : options.roomId;
        this.id = this.roomId === null ? 'default' : 'game:' + this.roomId;
        this.settings = Object.assign({}, DEFAULT_GAME_SETTINGS, options.settings || {});
        this.config = Object.assign({}, DEFAULT_GAME_OPTIONS, options.config || {});
        this.competitive = options.competitive !== false;
        this.countdownMs = options.countdownMs === undefined ? 3000 : options.countdownMs;

        this.now = typeof options.now === 'function' ? options.now : Date.now;
        this.setTimeoutFn = options.setTimeoutFn || setTimeout;
        this.clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
        this.setIntervalFn = options.setIntervalFn || setInterval;
        this.clearIntervalFn = options.clearIntervalFn || clearInterval;
        this.logger = options.logger || console;

        this.emitToMember = options.emitToMember || noop;
        this.emitToRoom = options.emitToRoom || noop;
        this.onFinished = options.onFinished || noop;
        this.onHeartbeatTimeout = options.onHeartbeatTimeout || noop;

        if (!Number.isFinite(this.countdownMs) || this.countdownMs < 0) {
            throw new TypeError('countdownMs must be a non-negative number');
        }

        this.players = new Map();
        this.spectators = new Set();
        this.playerInfo = new Map();
        this.matchStats = new Map();
        this.disconnectedMembers = new Set();
        this.scoreWeights = normalizeWeights(options.scoreWeights);
        this.state = 'lobby';
        this.map = this._createMap();

        this.countdownEndsAt = null;
        this.startedAt = null;
        this.finishedAt = null;
        this.endReason = null;
        this.startPlayerCount = 0;
        this.deathsDuringGame = 0;

        this.leaderboard = [];
        this.leaderboardChanged = false;
        this.actionTimes = new Map();

        this.countdownTimer = null;
        this.tickInterval = null;
        this.gameLoopInterval = null;
        this.updateInterval = null;
    }

    get size() {
        return this.players.size;
    }

    get spectatorCount() {
        return this.spectators.size;
    }

    get isRunning() {
        return this.state === 'running';
    }

    _createMap() {
        return new mapUtils.Map({
            foodMass: this.settings.foodMass,
            foodUniformDisposition: this.config.foodUniformDisposition,
            virus: this.config.virus
        });
    }

    _randomPosition(radius) {
        return {
            x: util.randomInRange(radius, this.settings.mapWidth - radius),
            y: util.randomInRange(radius, this.settings.mapHeight - radius)
        };
    }

    _spawnPosition(radius) {
        const players = this.map.players.data;
        if (this.config.newPlayerInitialPosition !== 'farthest' || players.length === 0) {
            return this._randomPosition(radius);
        }

        let bestCandidate = null;
        let maxDistance = 0;
        const candidateCount = 10;

        for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex += 1) {
            const candidate = this._randomPosition(radius);
            let minDistance = Infinity;

            for (const player of players) {
                const distance = util.getDistance(candidate, player);
                if (distance < minDistance) {
                    minDistance = distance;
                }
            }

            if (minDistance > maxDistance) {
                bestCandidate = candidate;
                maxDistance = minDistance;
            } else {
                // Match the lobby's existing spawn behavior: stop early when a
                // candidate is not farther than the previous best.
                return this._randomPosition(radius);
            }
        }

        return bestCandidate || this._randomPosition(radius);
    }

    _playerInfo(memberId) {
        const info = this.playerInfo.get(memberId) || {};
        const screen = normalizeScreenSize(info.screenWidth, info.screenHeight, {
            fallbackWidth: DEFAULT_VIEW_WIDTH,
            fallbackHeight: DEFAULT_VIEW_HEIGHT,
            maxWidth: this.settings.mapWidth,
            maxHeight: this.settings.mapHeight
        });
        return {
            id: memberId,
            name: typeof info.name === 'string' && info.name.length > 0 ? info.name : 'Guest',
            accountId: info.accountId === undefined ? null : info.accountId,
            admin: Boolean(info.admin),
            screenWidth: screen.width,
            screenHeight: screen.height
        };
    }

    _spawnPlayer(memberId) {
        if (this.map.players.findIndexByID(memberId) !== -1) {
            return this.map.players.data[this.map.players.findIndexByID(memberId)];
        }

        const info = this._playerInfo(memberId);
        const player = new mapUtils.playerUtils.Player(memberId);
        const radius = util.massToRadius(this.settings.defaultPlayerMass);

        player.init(this._spawnPosition(radius), this.settings.defaultPlayerMass);
        player.clientProvidedData({
            name: info.name,
            screenWidth: info.screenWidth,
            screenHeight: info.screenHeight
        });
        player.accountId = info.accountId;
        player.admin = info.admin;
        player.disconnected = this.disconnectedMembers.has(memberId);

        this.matchStats.set(memberId, this._createMatchStats(memberId, info));

        this.map.players.pushNew(player);
        return player;
    }

    _createMatchStats(memberId, info = {}) {
        return {
            id: memberId,
            name: info.name || 'Guest',
            accountId: info.accountId === undefined ? null : info.accountId,
            foodEaten: 0,
            kills: 0,
            deaths: 0,
            massTotal: this.settings.defaultPlayerMass,
            peakMass: this.settings.defaultPlayerMass,
            survivedMs: 0,
            spawnedAt: this.now(),
            diedAt: null,
            alive: true,
            dnf: false,
            disconnected: this.disconnectedMembers.has(memberId)
        };
    }

    _syncPlayerStats(memberId, player) {
        const stats = this.matchStats.get(memberId);
        if (!stats || !player) {
            return stats;
        }

        stats.massTotal = Math.round(player.massTotal);
        if (stats.massTotal > stats.peakMass) {
            stats.peakMass = stats.massTotal;
        }
        return stats;
    }

    _statsWithSurvival(stats, at) {
        const survivedMs = stats.diedAt === null
            ? Math.max(0, at - stats.spawnedAt)
            : Math.max(0, stats.diedAt - stats.spawnedAt);

        return Object.assign({}, stats, { survivedMs });
    }

    _recordDeath(memberId, at) {
        const stats = this.matchStats.get(memberId);
        if (!stats || !stats.alive) {
            return;
        }

        stats.alive = false;
        stats.diedAt = at;
        stats.survivedMs = Math.max(0, at - stats.spawnedAt);
        stats.deaths += 1;
    }

    _markDnf(memberId, at) {
        const stats = this.matchStats.get(memberId);
        if (!stats || !stats.alive) {
            return;
        }

        stats.alive = false;
        stats.dnf = true;
        stats.disconnected = true;
        stats.diedAt = at;
        stats.survivedMs = Math.max(0, at - stats.spawnedAt);
        this.disconnectedMembers.add(memberId);
    }

    _despawnPlayer(memberId) {
        this.map.players.removePlayerByID(memberId);
    }

    /**
     * Add a player participant. Before the game runs this only records the
     * member; once running it also spawns a cell.
     */
    addPlayer(memberId, info = {}, options = {}) {
        if (typeof memberId !== 'string' || memberId.length === 0) {
            throw new TypeError('memberId is required');
        }

        this.players.set(memberId, true);
        this.spectators.delete(memberId);
        const screen = normalizeScreenSize(info.screenWidth, info.screenHeight, {
            fallbackWidth: DEFAULT_VIEW_WIDTH,
            fallbackHeight: DEFAULT_VIEW_HEIGHT,
            maxWidth: this.settings.mapWidth,
            maxHeight: this.settings.mapHeight
        });
        this.playerInfo.set(memberId, {
            name: info.name,
            accountId: info.accountId === undefined ? null : info.accountId,
            admin: Boolean(info.admin),
            screenWidth: screen.width,
            screenHeight: screen.height
        });

        if (this.state === 'running' && options.spawn !== false) {
            this._spawnPlayer(memberId);
        }

        return this;
    }

    addSpectator(memberId) {
        if (typeof memberId !== 'string' || memberId.length === 0) {
            throw new TypeError('memberId is required');
        }

        this.spectators.add(memberId);
        this.players.delete(memberId);
        if (this.state === 'running') {
            this._syncPlayerStats(memberId, this.getPlayer(memberId));
            this._markDnf(memberId, this.now());
        }
        this.map.players.removePlayerByID(memberId);
        return this;
    }

    removeMember(memberId) {
        const wasPlayer = this.players.delete(memberId);
        const wasSpectator = this.spectators.delete(memberId);
        if (!wasPlayer && !wasSpectator) {
            return false;
        }

        if (wasPlayer && this.state === 'running' && this.competitive) {
            this._syncPlayerStats(memberId, this.getPlayer(memberId));
            this._markDnf(memberId, this.now());
        }

        this.playerInfo.delete(memberId);
        this._despawnPlayer(memberId);
        this.disconnectedMembers.delete(memberId);

        if (wasPlayer && this.state === 'running' && this.competitive) {
            if (this.players.size === 0) {
                this.finish('empty_room');
            } else if (this.startPlayerCount > 1 && this.players.size <= 1) {
                this.finish('not_enough_players');
            }
        }

        return true;
    }

    hasPlayer(memberId) {
        return this.players.has(memberId);
    }

    hasSpectator(memberId) {
        return this.spectators.has(memberId);
    }

    getMemberIds() {
        return Array.from(this.players.keys()).concat(Array.from(this.spectators));
    }

    getPlayer(memberId) {
        const index = this.map.players.findIndexByID(memberId);
        return index === -1 ? null : this.map.players.data[index];
    }

    setScreenSize(memberId, screenWidth, screenHeight) {
        const info = this.playerInfo.get(memberId);
        if (!info) {
            return false;
        }

        const screen = normalizeScreenSize(screenWidth, screenHeight, {
            fallbackWidth: info.screenWidth || DEFAULT_VIEW_WIDTH,
            fallbackHeight: info.screenHeight || DEFAULT_VIEW_HEIGHT,
            maxWidth: this.settings.mapWidth,
            maxHeight: this.settings.mapHeight
        });

        info.screenWidth = screen.width;
        info.screenHeight = screen.height;

        const player = this.getPlayer(memberId);
        if (player) {
            player.screenWidth = screen.width;
            player.screenHeight = screen.height;
        }

        return true;
    }

    setAdmin(memberId, admin) {
        const info = this.playerInfo.get(memberId);
        if (!info) {
            return false;
        }

        info.admin = Boolean(admin);
        const player = this.getPlayer(memberId);
        if (player) {
            player.admin = Boolean(admin);
        }
        return true;
    }

    /**
     * Mark a member as temporarily disconnected. While disconnected their
     * cell stays in the world (reserving their mass and position) but is not
     * simulated, so the reconnect grace period cannot be abused to keep
     * moving or eating while the client is gone.
     */
    markDisconnected(memberId) {
        const player = this.getPlayer(memberId);
        const stats = this.matchStats.get(memberId);
        const isMember = this.players.has(memberId) || this.spectators.has(memberId);

        if (!player && !stats && !isMember) {
            return false;
        }

        this.disconnectedMembers.add(memberId);
        if (player) {
            player.disconnected = true;
        }
        if (stats) {
            stats.disconnected = true;
        }
        return true;
    }

    /**
     * Clear a temporary disconnect and restart the heartbeat clock. This is
     * called when a member rejoins within the grace period.
     */
    markReconnected(memberId) {
        const player = this.getPlayer(memberId);
        const stats = this.matchStats.get(memberId);
        const isMember = this.players.has(memberId) || this.spectators.has(memberId);

        if (!player && !stats && !isMember) {
            return false;
        }

        this.disconnectedMembers.delete(memberId);
        if (player) {
            player.disconnected = false;
            player.lastHeartbeat = this.now();
        }
        if (stats) {
            stats.disconnected = false;
        }
        return true;
    }

    isDisconnected(memberId) {
        if (this.disconnectedMembers.has(memberId)) {
            return true;
        }

        const player = this.getPlayer(memberId);
        if (player) {
            return Boolean(player.disconnected);
        }

        const stats = this.matchStats.get(memberId);
        return Boolean(stats && stats.disconnected);
    }

    _coolingDown(memberId, action, cooldownMs) {
        if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) {
            return false;
        }

        const key = memberId + ':' + action;
        const now = this.now();
        const last = this.actionTimes.get(key);

        if (last !== undefined && now - last < cooldownMs) {
            return true;
        }

        this.actionTimes.set(key, now);
        return false;
    }

    setTarget(memberId, target) {
        if (this.state !== 'running') {
            return false;
        }

        const player = this.getPlayer(memberId);
        if (!player) {
            return false;
        }

        const normalized = normalizeTarget(target, {
            maxOffset: Math.max(this.settings.mapWidth, this.settings.mapHeight) * 2
        });
        if (normalized === null) {
            return false;
        }

        if (player.disconnected) {
            this.markReconnected(memberId);
        }
        player.lastHeartbeat = this.now();
        if (normalized.x !== player.x || normalized.y !== player.y) {
            player.target = normalized;
        }
        return true;
    }

    fireFood(memberId) {
        if (this.state !== 'running') {
            return false;
        }

        const player = this.getPlayer(memberId);
        if (!player) {
            return false;
        }
        if (this._coolingDown(memberId, 'fireFood', this.config.fireFoodCooldownMs)) {
            return false;
        }

        const minCellMass = this.settings.defaultPlayerMass + this.config.fireFood;
        let fired = false;
        for (let index = 0; index < player.cells.length; index += 1) {
            if (player.cells[index].mass >= minCellMass) {
                player.changeCellMass(index, -this.config.fireFood);
                this.map.massFood.addNew(player, index, this.config.fireFood);
                fired = true;
            }
        }
        return fired;
    }

    split(memberId) {
        if (this.state !== 'running') {
            return false;
        }

        const player = this.getPlayer(memberId);
        if (!player) {
            return false;
        }
        if (this._coolingDown(memberId, 'split', this.config.splitCooldownMs)) {
            return false;
        }

        player.userSplit(this.config.limitSplit, this.settings.defaultPlayerMass);
        return true;
    }

    despawnPlayer(memberId) {
        this._despawnPlayer(memberId);
    }

    /**
     * Start the legacy default world. It is always running and has no
     * countdown or match end conditions.
     */
    startRunning() {
        if (this.state === 'running') {
            return this;
        }

        this._clearTimers();
        this.map = this._createMap();
        this.state = 'running';
        this.startedAt = this.now();
        this.finishedAt = null;
        this.endReason = null;
        this.startPlayerCount = this.players.size;
        this.deathsDuringGame = 0;
        this.leaderboard = [];
        this.leaderboardChanged = false;
        this.actionTimes.clear();
        this.matchStats.clear();
        this._startIntervals();

        for (const memberId of this.players.keys()) {
            this._spawnPlayer(memberId);
        }

        return this;
    }

    /**
     * Begin the room countdown. RoomLobby validates owner/minimum/ready rules
     * before calling this.
     */
    start() {
        if (this.state === 'countdown' || this.state === 'running') {
            return false;
        }
        if (this.state === 'finished') {
            this.reset();
        }

        this.state = 'countdown';
        this.countdownEndsAt = this.now() + this.countdownMs;
        this.finishedAt = null;
        this.endReason = null;

        this._emitState();
        this.emitToRoom('gameCountdown', {
            roomId: this.roomId,
            state: this.state,
            countdownMs: this.countdownMs,
            startsAt: this.countdownEndsAt
        });

        if (this.countdownMs === 0) {
            this._beginRunning();
        } else {
            this.countdownTimer = this.setTimeoutFn(() => {
                this.countdownTimer = null;
                this._beginRunning();
            }, this.countdownMs);
            if (this.countdownTimer && typeof this.countdownTimer.unref === 'function') {
                this.countdownTimer.unref();
            }
        }

        return true;
    }

    _beginRunning() {
        if (this.state !== 'countdown') {
            return;
        }

        this.countdownEndsAt = null;
        this.map = this._createMap();
        this.state = 'running';
        this.startedAt = this.now();
        this.finishedAt = null;
        this.endReason = null;
        this.startPlayerCount = this.players.size;
        this.deathsDuringGame = 0;
        this.leaderboard = [];
        this.leaderboardChanged = false;
        this.actionTimes.clear();
        this.matchStats.clear();

        for (const memberId of this.players.keys()) {
            this._spawnPlayer(memberId);
        }

        this._startIntervals();
        this._emitState();
        this.emitToRoom('gameStart', this.snapshot());
    }

    _startIntervals() {
        this._clearIntervals();

        this.tickInterval = this.setIntervalFn(() => this.tickGame(), 1000 / 60);
        this.gameLoopInterval = this.setIntervalFn(() => this.gameloop(), 1000);
        this.updateInterval = this.setIntervalFn(
            () => this.sendUpdates(),
            1000 / this.config.networkUpdateFactor
        );

        for (const timer of [this.tickInterval, this.gameLoopInterval, this.updateInterval]) {
            if (timer && typeof timer.unref === 'function') {
                timer.unref();
            }
        }
    }

    _clearIntervals() {
        if (this.tickInterval !== null) {
            this.clearIntervalFn(this.tickInterval);
            this.tickInterval = null;
        }
        if (this.gameLoopInterval !== null) {
            this.clearIntervalFn(this.gameLoopInterval);
            this.gameLoopInterval = null;
        }
        if (this.updateInterval !== null) {
            this.clearIntervalFn(this.updateInterval);
            this.updateInterval = null;
        }
    }

    _clearTimers() {
        this._clearIntervals();
        if (this.countdownTimer !== null) {
            this.clearTimeoutFn(this.countdownTimer);
            this.countdownTimer = null;
        }
    }

    _tickPlayer(player, now) {
        if (player.disconnected) {
            return;
        }

        if (player.lastHeartbeat < now - this.config.maxHeartbeatInterval) {
            player.disconnected = true;
            this.onHeartbeatTimeout(player.id, 'Last heartbeat received over ' +
                this.config.maxHeartbeatInterval + ' ago.');
            return;
        }

        player.move(
            this.config.slowBase,
            this.settings.mapWidth,
            this.settings.mapHeight,
            util.mathLog(this.settings.defaultPlayerMass, this.config.slowBase)
        );

        const isEntityInsideCircle = (point, circle) => {
            return SAT.pointInCircle(new Vector(point.x, point.y), circle);
        };

        const canEatMass = (cell, cellCircle, cellIndex, mass) => {
            if (isEntityInsideCircle(mass, cellCircle)) {
                if (mass.id === player.id && mass.speed > 0 && cellIndex === mass.num) {
                    return false;
                }
                if (cell.mass > mass.mass * 1.1) {
                    return true;
                }
            }
            return false;
        };

        const canEatVirus = (cell, cellCircle, virus) => {
            return virus.mass < cell.mass && isEntityInsideCircle(virus, cellCircle);
        };

        const cellsToSplit = [];
        for (let cellIndex = 0; cellIndex < player.cells.length; cellIndex += 1) {
            const currentCell = player.cells[cellIndex];
            const cellCircle = currentCell.toCircle();

            const eatenFoodIndexes = util.getIndexes(
                this.map.food.data,
                (food) => isEntityInsideCircle(food, cellCircle)
            );
            const eatenMassIndexes = util.getIndexes(
                this.map.massFood.data,
                (mass) => canEatMass(currentCell, cellCircle, cellIndex, mass)
            );
            const eatenVirusIndexes = util.getIndexes(
                this.map.viruses.data,
                (virus) => canEatVirus(currentCell, cellCircle, virus)
            );

            if (eatenVirusIndexes.length > 0) {
                cellsToSplit.push(cellIndex);
                this.map.viruses.delete(eatenVirusIndexes);
            }

            let massGained = eatenMassIndexes.reduce(
                (total, index) => total + this.map.massFood.data[index].mass,
                0
            );

            this.map.food.delete(eatenFoodIndexes);
            this.map.massFood.remove(eatenMassIndexes);
            massGained += eatenFoodIndexes.length * this.settings.foodMass;
            player.changeCellMass(cellIndex, massGained);

            const stats = this.matchStats.get(player.id);
            if (stats) {
                stats.foodEaten += eatenFoodIndexes.length + eatenMassIndexes.length;
            }
        }

        player.virusSplit(cellsToSplit, this.config.limitSplit, this.settings.defaultPlayerMass);
        this._syncPlayerStats(player.id, player);
    }

    tickGame() {
        if (this.state !== 'running') {
            return;
        }

        const now = this.now();
        for (const player of this.map.players.data.slice()) {
            if (this.state !== 'running') {
                break;
            }
            this._tickPlayer(player, now);
        }

        this.map.massFood.move(this.settings.mapWidth, this.settings.mapHeight);

        this.map.players.handleCollisions((gotEaten, eater) => {
            if (this.state !== 'running') {
                return;
            }

            const cellGotEaten = this.map.players.getCell(gotEaten.playerIndex, gotEaten.cellIndex);
            if (!cellGotEaten) {
                return;
            }

            const eaterPlayer = this.map.players.data[eater.playerIndex];
            eaterPlayer.changeCellMass(
                eater.cellIndex,
                cellGotEaten.mass
            );
            this._syncPlayerStats(eaterPlayer.id, eaterPlayer);

            const dyingPlayer = this.map.players.data[gotEaten.playerIndex];
            if (dyingPlayer) {
                this._syncPlayerStats(dyingPlayer.id, dyingPlayer);
            }

            const playerDied = this.map.players.removeCell(gotEaten.playerIndex, gotEaten.cellIndex);
            if (!playerDied) {
                return;
            }

            const deadPlayer = this.map.players.data[gotEaten.playerIndex];
            if (!deadPlayer) {
                return;
            }

            this.deathsDuringGame += 1;
            this._recordDeath(deadPlayer.id, now);
            if (eaterPlayer && eaterPlayer.id !== deadPlayer.id) {
                const killerStats = this.matchStats.get(eaterPlayer.id);
                if (killerStats) {
                    killerStats.kills += 1;
                }
            }
            this.emitToRoom('playerDied', { name: deadPlayer.name });
            this.emitToMember(deadPlayer.id, 'RIP');
            this.map.players.removePlayerByIndex(gotEaten.playerIndex);

            if (
                this.competitive &&
                this.startPlayerCount > 1 &&
                this.map.players.data.length <= 1
            ) {
                this.finish('last_player_standing');
            }
        });
    }

    gameloop() {
        if (this.state !== 'running') {
            return;
        }

        if (this.map.players.data.length > 0) {
            this.calculateLeaderboard();
            this.map.players.shrinkCells(
                this.config.massLossRate,
                this.settings.defaultPlayerMass,
                this.config.minMassLoss
            );
        }

        this.map.balanceMass(
            this.settings.foodMass,
            this.settings.gameMass,
            this.settings.maxFood,
            this.settings.maxVirus
        );

        this._checkLimits();
    }

    _checkLimits() {
        if (this.state !== 'running') {
            return;
        }

        const now = this.now();

        if (
            this.settings.timeLimitMs > 0 &&
            this.startedAt !== null &&
            now - this.startedAt >= this.settings.timeLimitMs
        ) {
            this.finish('time_limit');
            return;
        }

        if (this.settings.scoreLimit > 0) {
            for (const player of this.map.players.data) {
                if (player.massTotal >= this.settings.scoreLimit) {
                    this.finish('score_limit');
                    return;
                }
            }
        }
    }

    calculateLeaderboard() {
        const topPlayers = this.map.players.getTopPlayers().map((entry) => {
            const stats = this.matchStats.get(entry.id) || {};
            return {
                id: entry.id,
                name: entry.name,
                massTotal: entry.massTotal,
                kills: stats.kills || 0
            };
        });

        if (this.leaderboard.length !== topPlayers.length) {
            this.leaderboard = topPlayers;
            this.leaderboardChanged = true;
            return;
        }

        for (let index = 0; index < this.leaderboard.length; index += 1) {
            if (
                this.leaderboard[index].id !== topPlayers[index].id ||
                this.leaderboard[index].massTotal !== topPlayers[index].massTotal ||
                this.leaderboard[index].kills !== topPlayers[index].kills
            ) {
                this.leaderboard = topPlayers;
                this.leaderboardChanged = true;
                return;
            }
        }
    }

    sendLeaderboard(memberId) {
        this.emitToMember(memberId, 'leaderboard', {
            players: this.map.players.data.length,
            leaderboard: this.leaderboard
        });
    }

    sendUpdates() {
        if (this.state !== 'running') {
            return;
        }

        for (const spectatorId of this.spectators) {
            this._sendSpectatorUpdate(spectatorId);
        }

        this.map.enumerateWhatPlayersSee((playerData, visiblePlayers, visibleFood, visibleMass, visibleViruses) => {
            this.emitToMember(
                playerData.id,
                'serverTellPlayerMove',
                playerData,
                visiblePlayers,
                visibleFood,
                visibleMass,
                visibleViruses
            );

            if (this.leaderboardChanged) {
                this.sendLeaderboard(playerData.id);
            }
        });

        this.leaderboardChanged = false;
    }

    _sendSpectatorUpdate(spectatorId) {
        const spectatorData = {
            x: this.settings.mapWidth / 2,
            y: this.settings.mapHeight / 2,
            cells: [],
            massTotal: 0,
            hue: 100,
            id: spectatorId,
            name: ''
        };

        this.emitToMember(
            spectatorId,
            'serverTellPlayerMove',
            spectatorData,
            this.map.players.data,
            this.map.food.data,
            this.map.massFood.data,
            this.map.viruses.data
        );

        if (this.leaderboardChanged) {
            this.sendLeaderboard(spectatorId);
        }
    }

    finish(reason = 'finished') {
        if (this.state !== 'running' && this.state !== 'countdown') {
            return false;
        }

        this._clearTimers();
        this.state = 'finished';
        this.finishedAt = this.now();
        this.endReason = reason;
        this.countdownEndsAt = null;

        const result = this.result(reason);
        this._emitState();
        this.emitToRoom('gameEnd', result);

        try {
            this.onFinished(result);
        } catch (err) {
            this.logger.error('[GAME] Finished callback failed:', err);
        }

        return true;
    }

    reset() {
        this._clearTimers();
        this.map = this._createMap();
        this.state = 'lobby';
        this.countdownEndsAt = null;
        this.startedAt = null;
        this.finishedAt = null;
        this.endReason = null;
        this.startPlayerCount = 0;
        this.deathsDuringGame = 0;
        this.leaderboard = [];
        this.leaderboardChanged = false;
        this.actionTimes.clear();
        this.matchStats.clear();
        this.disconnectedMembers.clear();
        this._emitState();
        return this;
    }

    close() {
        this._clearTimers();
        this.state = 'closed';
        this.map = this._createMap();
        this.players.clear();
        this.spectators.clear();
        this.playerInfo.clear();
        this.leaderboard = [];
        this.leaderboardChanged = false;
        this.actionTimes.clear();
        this.matchStats.clear();
        this.disconnectedMembers.clear();
        return this;
    }

    _emitState() {
        this.emitToRoom('gameState', this.snapshot());
    }

    snapshot() {
        const playerList = [];
        const at = this.finishedAt === null ? this.now() : this.finishedAt;
        for (const memberId of this.players.keys()) {
            const info = this.playerInfo.get(memberId) || {};
            const player = this.getPlayer(memberId);
            const stats = this.matchStats.get(memberId);
            const scoredStats = stats ? this._statsWithSurvival(stats, at) : null;
            playerList.push({
                id: memberId,
                name: info.name || 'Guest',
                admin: Boolean(info.admin),
                alive: player !== null,
                massTotal: player ? Math.round(player.massTotal) : 0,
                kills: stats ? stats.kills : 0,
                foodEaten: stats ? stats.foodEaten : 0,
                score: scoredStats ? scorePlayer(scoredStats, this.scoreWeights) : 0,
                dnf: stats ? Boolean(stats.dnf) : false,
                disconnected: this.isDisconnected(memberId)
            });
        }

        return {
            roomId: this.roomId,
            state: this.state,
            competitive: this.competitive,
            countdownMs: this.countdownMs,
            countdownEndsAt: this.countdownEndsAt,
            startedAt: this.startedAt,
            finishedAt: this.finishedAt,
            endReason: this.endReason,
            timeLimitMs: this.settings.timeLimitMs,
            scoreLimit: this.settings.scoreLimit,
            scoreWeights: Object.assign({}, this.scoreWeights),
            map: {
                width: this.settings.mapWidth,
                height: this.settings.mapHeight
            },
            playerCount: this.players.size,
            spectatorCount: this.spectators.size,
            players: playerList,
            spectators: Array.from(this.spectators)
        };
    }

    result(reason = this.endReason) {
        const at = this.finishedAt === null ? this.now() : this.finishedAt;
        const statsList = [];
        const memberIds = new Set(this.matchStats.keys());

        for (const memberId of this.players.keys()) {
            memberIds.add(memberId);
        }

        for (const memberId of memberIds) {
            const player = this.getPlayer(memberId);
            let stats = this.matchStats.get(memberId);

            if (!stats) {
                const info = this.playerInfo.get(memberId) || {};
                stats = this._createMatchStats(memberId, info);
                this.matchStats.set(memberId, stats);
            }

            if (player) {
                this._syncPlayerStats(memberId, player);
            }

            statsList.push(this._statsWithSurvival(stats, at));
        }

        const scores = rankPlayers(statsList, this.scoreWeights);
        const winners = scores.filter((entry) => entry.winner);

        return {
            roomId: this.roomId,
            state: this.state,
            reason,
            startedAt: this.startedAt,
            finishedAt: this.finishedAt,
            durationMs: this.startedAt === null || this.finishedAt === null
                ? 0
                : Math.max(0, this.finishedAt - this.startedAt),
            winner: winners.length === 1 ? winners[0].id : null,
            winners: winners.map((entry) => entry.id),
            tie: winners.length > 1,
            scoreWeights: Object.assign({}, this.scoreWeights),
            scores
        };
    }
}

function createGameSession(options) {
    return new GameSession(options);
}

module.exports = {
    DEFAULT_GAME_SETTINGS,
    GameSession,
    createGameSession
};
