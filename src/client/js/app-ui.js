'use strict';

const {
    formatRoomMeta,
    formatMemberStatus,
    formatCountdown,
    countdownRemaining,
    resultEntries,
    formatResultTitle,
    formatResultSubtitle,
    formatRank,
    formatScore
} = require('./ui-format');

function byId(id) {
    return document.getElementById(id);
}

function setHidden(element, hidden) {
    if (!element) {
        return;
    }
    if (hidden) {
        element.classList.add('is-hidden');
    } else {
        element.classList.remove('is-hidden');
    }
}

function setText(element, text) {
    if (element) {
        element.textContent = text;
    }
}

function setValue(element, value) {
    if (element) {
        element.value = value;
    }
}

function numberOrNull(value) {
    if (value === null || value === undefined || String(value).trim() === '') {
        return null;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function minutesToMs(minutes) {
    if (minutes === null) {
        return null;
    }
    return Math.max(0, Math.round(minutes * 60000));
}

function msToMinutes(ms) {
    const minutes = Math.max(0, Number(ms) || 0) / 60000;
    return Number.isInteger(minutes) ? String(minutes) : String(Math.round(minutes * 10) / 10);
}

/**
 * DOM controller for the account, lobby, room and match-result screens.
 *
 * All server communication lives in `app.js`; this class only renders state
 * and forwards user intent through the supplied action handlers.
 */
class AppUI {
    constructor(options = {}) {
        if (!options.sessionStore) {
            throw new TypeError('sessionStore is required');
        }
        if (!options.roomStore) {
            throw new TypeError('roomStore is required');
        }

        this.sessionStore = options.sessionStore;
        this.roomStore = options.roomStore;
        this.actions = options.actions || {};
        this.screen = 'auth';
        this.authTab = 'login';
        this.countdownTimer = null;
        this.countdownStartsAt = null;
        this._settingsKey = '';

        this.elements = {
            authScreen: byId('authScreen'),
            lobbyScreen: byId('lobbyScreen'),
            roomScreen: byId('roomScreen'),
            gameArea: byId('gameAreaWrapper'),
            gameHud: byId('gameHud'),
            gameRoomLabel: byId('gameRoomLabel'),
            gameLeaveButton: byId('gameLeaveButton'),
            gameStopButton: byId('gameStopButton'),

            loginTab: byId('loginTab'),
            registerTab: byId('registerTab'),
            loginForm: byId('loginForm'),
            registerForm: byId('registerForm'),
            guestForm: byId('guestForm'),
            loginUsername: byId('loginUsername'),
            loginPassword: byId('loginPassword'),
            registerUsername: byId('registerUsername'),
            registerPassword: byId('registerPassword'),
            registerConfirm: byId('registerConfirm'),
            guestNameInput: byId('guestNameInput'),
            loginButton: byId('loginButton'),
            registerButton: byId('registerButton'),
            guestButton: byId('guestButton'),
            quickPlayButton: byId('quickPlayButton'),
            spectateButton: byId('spectateButton'),
            authError: byId('authError'),
            authSettingsButton: byId('authSettingsButton'),
            instructionsButton: byId('instructionsButton'),
            settings: byId('settings'),
            instructions: byId('instructions'),

            lobbyIdentity: byId('lobbyIdentity'),
            refreshRoomsButton: byId('refreshRoomsButton'),
            logoutButton: byId('logoutButton'),
            createRoomForm: byId('createRoomForm'),
            createRoomName: byId('createRoomName'),
            createRoomVisibility: byId('createRoomVisibility'),
            createRoomButton: byId('createRoomButton'),
            joinRoomForm: byId('joinRoomForm'),
            joinRoomCode: byId('joinRoomCode'),
            joinRoomButton: byId('joinRoomButton'),
            lobbyError: byId('lobbyError'),
            roomsLoading: byId('roomsLoading'),
            roomsEmpty: byId('roomsEmpty'),
            roomsError: byId('roomsError'),
            roomList: byId('roomList'),

            roomName: byId('roomName'),
            roomMeta: byId('roomMeta'),
            roomCode: byId('roomCode'),
            roomError: byId('roomError'),
            roomPlayerCount: byId('roomPlayerCount'),
            roomPlayerList: byId('roomPlayerList'),
            roomSpectatorCount: byId('roomSpectatorCount'),
            roomSpectatorList: byId('roomSpectatorList'),
            roomHint: byId('roomHint'),
            roomCountdown: byId('roomCountdown'),
            roomCountdownValue: byId('roomCountdownValue'),
            readyButton: byId('readyButton'),
            startGameButton: byId('startGameButton'),
            stopGameButton: byId('stopGameButton'),
            leaveRoomButton: byId('leaveRoomButton'),
            roomSettings: byId('roomSettings'),
            roomSettingsForm: byId('roomSettingsForm'),
            settingName: byId('settingName'),
            settingVisibility: byId('settingVisibility'),
            settingMaxPlayers: byId('settingMaxPlayers'),
            settingMapWidth: byId('settingMapWidth'),
            settingMapHeight: byId('settingMapHeight'),
            settingTimeLimit: byId('settingTimeLimit'),
            settingScoreLimit: byId('settingScoreLimit'),
            saveSettingsButton: byId('saveSettingsButton'),
            deleteRoomButton: byId('deleteRoomButton'),

            gameOverOverlay: byId('gameOverOverlay'),
            gameOverTitle: byId('gameOverTitle'),
            gameOverSubtitle: byId('gameOverSubtitle'),
            gameOverScores: byId('gameOverScores'),
            returnToLobbyButton: byId('returnToLobbyButton'),
            returnToLobbyHint: byId('returnToLobbyHint'),
            leaveAfterGameButton: byId('leaveAfterGameButton')
        };

        if (this.elements.guestNameInput) {
            this.elements.guestNameInput.value = this.sessionStore.guestName;
        }

        this._bind();
        this.showAuth('');
    }

    _bind() {
        const el = this.elements;
        const actions = this.actions;

        if (el.loginTab) {
            el.loginTab.addEventListener('click', () => this.setAuthTab('login'));
        }
        if (el.registerTab) {
            el.registerTab.addEventListener('click', () => this.setAuthTab('register'));
        }

        if (el.loginForm) {
            el.loginForm.addEventListener('submit', (event) => {
                event.preventDefault();
                const username = el.loginUsername.value.trim();
                const password = el.loginPassword.value;
                if (!username || !password) {
                    this.setAuthError('Enter your username and password.');
                    return;
                }
                this.setAuthError('');
                if (typeof actions.login === 'function') {
                    actions.login({ username, password });
                }
            });
        }

        if (el.registerForm) {
            el.registerForm.addEventListener('submit', (event) => {
                event.preventDefault();
                const username = el.registerUsername.value.trim();
                const password = el.registerPassword.value;
                const confirm = el.registerConfirm.value;
                if (!username || !password) {
                    this.setAuthError('Choose a username and password.');
                    return;
                }
                if (password !== confirm) {
                    this.setAuthError('The passwords do not match.');
                    return;
                }
                this.setAuthError('');
                if (typeof actions.register === 'function') {
                    actions.register({ username, password });
                }
            });
        }

        if (el.guestForm) {
            el.guestForm.addEventListener('submit', (event) => {
                event.preventDefault();
                if (!this._submitGuestName()) {
                    return;
                }
                if (typeof actions.guest === 'function') {
                    actions.guest(el.guestNameInput.value.trim());
                }
            });
        }

        if (el.quickPlayButton) {
            el.quickPlayButton.addEventListener('click', () => {
                if (!this._submitGuestName()) {
                    return;
                }
                if (typeof actions.quickPlay === 'function') {
                    actions.quickPlay(el.guestNameInput.value.trim());
                }
            });
        }

        if (el.spectateButton) {
            el.spectateButton.addEventListener('click', () => {
                if (!this._submitGuestName()) {
                    return;
                }
                if (typeof actions.quickSpectate === 'function') {
                    actions.quickSpectate(el.guestNameInput.value.trim());
                }
            });
        }

        if (el.authSettingsButton) {
            el.authSettingsButton.addEventListener('click', () => {
                this._togglePanel(el.settings);
            });
        }

        if (el.instructionsButton) {
            el.instructionsButton.addEventListener('click', () => {
                this._togglePanel(el.instructions);
            });
        }

        if (el.refreshRoomsButton) {
            el.refreshRoomsButton.addEventListener('click', () => {
                if (typeof actions.refreshRooms === 'function') {
                    actions.refreshRooms();
                }
            });
        }

        if (el.logoutButton) {
            el.logoutButton.addEventListener('click', () => {
                if (typeof actions.logout === 'function') {
                    actions.logout();
                }
            });
        }

        if (el.createRoomForm) {
            el.createRoomForm.addEventListener('submit', (event) => {
                event.preventDefault();
                const name = el.createRoomName.value.trim();
                if (!name) {
                    this.setLobbyError('Enter a room name.');
                    return;
                }
                this.setLobbyError('');
                if (typeof actions.createRoom === 'function') {
                    actions.createRoom({
                        name,
                        visibility: el.createRoomVisibility.value
                    });
                }
            });
        }

        if (el.joinRoomForm) {
            el.joinRoomForm.addEventListener('submit', (event) => {
                event.preventDefault();
                const code = el.joinRoomCode.value.trim();
                if (!code) {
                    this.setLobbyError('Enter a room code.');
                    return;
                }
                this.setLobbyError('');
                if (typeof actions.joinRoom === 'function') {
                    actions.joinRoom({ code });
                }
            });
        }

        if (el.leaveRoomButton) {
            el.leaveRoomButton.addEventListener('click', () => this._leaveRoom());
        }
        if (el.gameLeaveButton) {
            el.gameLeaveButton.addEventListener('click', () => this._leaveRoom());
        }
        if (el.gameStopButton) {
            el.gameStopButton.addEventListener('click', () => {
                if (typeof actions.stopGame === 'function') {
                    actions.stopGame();
                }
            });
        }
        if (el.leaveAfterGameButton) {
            el.leaveAfterGameButton.addEventListener('click', () => this._leaveRoom());
        }

        if (el.readyButton) {
            el.readyButton.addEventListener('click', () => {
                if (typeof actions.setReady === 'function') {
                    actions.setReady(!this.roomStore.isReady);
                }
            });
        }

        if (el.startGameButton) {
            el.startGameButton.addEventListener('click', () => {
                if (typeof actions.startGame === 'function') {
                    actions.startGame();
                }
            });
        }

        if (el.stopGameButton) {
            el.stopGameButton.addEventListener('click', () => {
                if (typeof actions.stopGame === 'function') {
                    actions.stopGame();
                }
            });
        }

        if (el.roomSettingsForm) {
            el.roomSettingsForm.addEventListener('submit', (event) => {
                event.preventDefault();
                this._saveRoomSettings();
            });
        }

        if (el.deleteRoomButton) {
            el.deleteRoomButton.addEventListener('click', () => {
                const room = this.roomStore.room;
                if (!room) {
                    return;
                }
                if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
                    if (!window.confirm('Delete "' + room.name + '"? This cannot be undone.')) {
                        return;
                    }
                }
                if (typeof actions.deleteRoom === 'function') {
                    actions.deleteRoom();
                }
            });
        }

        if (el.returnToLobbyButton) {
            el.returnToLobbyButton.addEventListener('click', () => {
                if (typeof actions.returnToLobby === 'function') {
                    actions.returnToLobby();
                }
            });
        }
    }

    _submitGuestName() {
        const name = this.elements.guestNameInput
            ? this.elements.guestNameInput.value.trim()
            : this.sessionStore.guestName;

        if (!/^\w+$/.test(name)) {
            this.setAuthError('Guest names may only contain letters, numbers and underscores.');
            return false;
        }
        if (name.length > 25) {
            this.setAuthError('Guest names must be 25 characters or fewer.');
            return false;
        }

        this.sessionStore.setGuestName(name);
        this.setAuthError('');
        return true;
    }

    _togglePanel(element) {
        if (!element) {
            return;
        }
        element.classList.toggle('is-open');
    }

    _leaveRoom() {
        if (typeof this.actions.leaveRoom === 'function') {
            this.actions.leaveRoom();
        }
    }

    _saveRoomSettings() {
        const el = this.elements;
        const room = this.roomStore.room;
        if (!room) {
            return;
        }

        const settings = {};
        const maxPlayers = numberOrNull(el.settingMaxPlayers.value);
        const mapWidth = numberOrNull(el.settingMapWidth.value);
        const mapHeight = numberOrNull(el.settingMapHeight.value);
        const scoreLimit = numberOrNull(el.settingScoreLimit.value);
        const timeLimitMs = minutesToMs(numberOrNull(el.settingTimeLimit.value));

        if (maxPlayers !== null) {
            settings.maxPlayers = Math.round(maxPlayers);
        }
        if (mapWidth !== null) {
            settings.mapWidth = Math.round(mapWidth);
        }
        if (mapHeight !== null) {
            settings.mapHeight = Math.round(mapHeight);
        }
        if (scoreLimit !== null) {
            settings.scoreLimit = Math.round(scoreLimit);
        }
        if (timeLimitMs !== null) {
            settings.timeLimitMs = timeLimitMs;
        }

        this.setRoomError('');
        if (typeof this.actions.updateRoom === 'function') {
            this.actions.updateRoom({
                name: el.settingName.value.trim(),
                visibility: el.settingVisibility.value,
                settings
            });
        }
    }

    setAuthTab(tab) {
        this.authTab = tab === 'register' ? 'register' : 'login';
        const login = this.authTab === 'login';

        if (this.elements.loginTab) {
            this.elements.loginTab.classList.toggle('is-active', login);
            this.elements.loginTab.setAttribute('aria-selected', login ? 'true' : 'false');
        }
        if (this.elements.registerTab) {
            this.elements.registerTab.classList.toggle('is-active', !login);
            this.elements.registerTab.setAttribute('aria-selected', login ? 'false' : 'true');
        }
        setHidden(this.elements.loginForm, !login);
        setHidden(this.elements.registerForm, login);
    }

    setAuthError(message) {
        setText(this.elements.authError, message || '');
    }

    setLobbyError(message) {
        setText(this.elements.lobbyError, message || '');
    }

    setRoomError(message) {
        setText(this.elements.roomError, message || '');
        if (this.roomStore) {
            this.roomStore.setError(message || '');
        }
    }

    setIdentity(text) {
        setText(this.elements.lobbyIdentity, text || '');
    }

    setBusy(scope, busy) {
        const el = this.elements;
        const disabled = Boolean(busy);

        if (scope === 'auth') {
            [el.loginButton, el.registerButton, el.guestButton, el.quickPlayButton,
                el.spectateButton]
                .forEach((button) => {
                    if (button) {
                        button.disabled = disabled;
                    }
                });
        } else if (scope === 'lobby') {
            [el.createRoomButton, el.joinRoomButton, el.refreshRoomsButton]
                .forEach((button) => {
                    if (button) {
                        button.disabled = disabled;
                    }
                });
        } else if (scope === 'room') {
            [el.readyButton, el.startGameButton, el.stopGameButton, el.saveSettingsButton,
                el.deleteRoomButton, el.leaveRoomButton]
                .forEach((button) => {
                    if (button) {
                        button.disabled = disabled;
                    }
                });
        }
    }

    showAuth(message) {
        this.screen = 'auth';
        this._clearCountdown();
        this.hideGameOver();
        this._hideGame();
        setHidden(this.elements.authScreen, false);
        setHidden(this.elements.lobbyScreen, true);
        setHidden(this.elements.roomScreen, true);
        setHidden(this.elements.gameHud, true);
        setText(this.elements.authError, message || '');

        window.setTimeout(() => {
            if (this.elements.loginUsername && this.authTab === 'login') {
                this.elements.loginUsername.focus();
            }
        }, 30);
    }

    showLobby() {
        this.screen = 'lobby';
        this._clearCountdown();
        this.hideGameOver();
        this._hideGame();
        setHidden(this.elements.authScreen, true);
        setHidden(this.elements.lobbyScreen, false);
        setHidden(this.elements.roomScreen, true);
        setHidden(this.elements.gameHud, true);
        this.setRoomError('');
        this.renderRoomList();
    }

    showRoom() {
        this.screen = 'room';
        this.hideGameOver();
        this._hideGame();
        setHidden(this.elements.authScreen, true);
        setHidden(this.elements.lobbyScreen, true);
        setHidden(this.elements.roomScreen, false);
        setHidden(this.elements.gameHud, true);
        this.renderRoom();
    }

    showGame(room, role) {
        this.screen = 'game';
        this.hideGameOver();
        this._clearCountdown();
        setHidden(this.elements.authScreen, true);
        setHidden(this.elements.lobbyScreen, true);
        setHidden(this.elements.roomScreen, true);

        if (this.elements.gameArea) {
            this.elements.gameArea.classList.add('is-active');
            this.elements.gameArea.style.opacity = '1';
        }

        if (room) {
            setHidden(this.elements.gameHud, false);
            const suffix = role === 'spectator' ? 'Spectating' : 'Playing';
            setText(this.elements.gameRoomLabel, room.name + ' · ' + suffix);
            setHidden(
                this.elements.gameStopButton,
                !(role !== 'spectator' && this.roomStore.isOwner)
            );
        } else {
            setHidden(this.elements.gameHud, true);
        }
    }

    _hideGame() {
        if (this.elements.gameArea) {
            this.elements.gameArea.classList.remove('is-active');
            this.elements.gameArea.style.opacity = '0';
        }
    }

    renderRoomList() {
        const store = this.roomStore;
        const el = this.elements;
        if (!el.roomList) {
            return;
        }

        el.roomList.textContent = '';
        setHidden(el.roomsLoading, !store.roomsLoading);
        setText(el.roomsError, store.roomsError || '');
        const showEmpty = !store.roomsLoading && store.rooms.length === 0 && !store.roomsError;
        setHidden(el.roomsEmpty, !showEmpty);

        for (const room of store.rooms) {
            el.roomList.appendChild(this._createRoomCard(room));
        }
    }

    _createRoomCard(room) {
        const item = document.createElement('li');
        item.className = 'room-card';

        const main = document.createElement('div');
        main.className = 'room-card-main';

        const title = document.createElement('p');
        title.className = 'room-card-title';
        title.textContent = room.name;
        main.appendChild(title);

        const meta = document.createElement('p');
        meta.className = 'room-card-meta';
        meta.textContent = formatRoomMeta(room) + ' · Code ' + room.code;
        main.appendChild(meta);

        const actions = document.createElement('div');
        actions.className = 'room-card-actions';

        const join = document.createElement('button');
        join.type = 'button';
        join.className = 'primary-button';
        join.textContent = 'Join';
        join.addEventListener('click', () => {
            if (typeof this.actions.joinRoom === 'function') {
                this.actions.joinRoom({ id: room.id });
            }
        });
        actions.appendChild(join);

        const spectate = document.createElement('button');
        spectate.type = 'button';
        spectate.className = 'secondary-button';
        spectate.textContent = 'Spectate';
        spectate.addEventListener('click', () => {
            if (typeof this.actions.joinRoom === 'function') {
                this.actions.joinRoom({ id: room.id, asSpectator: true });
            }
        });
        actions.appendChild(spectate);

        item.appendChild(main);
        item.appendChild(actions);
        return item;
    }

    renderRoom() {
        const store = this.roomStore;
        const room = store.room;
        const el = this.elements;
        if (!room) {
            return;
        }

        setText(el.roomName, room.name);
        setText(el.roomMeta, formatRoomMeta(room));
        setText(el.roomCode, room.code);

        setText(el.roomPlayerCount, String(store.members.length));
        setText(el.roomSpectatorCount, String(store.spectators.length));

        this._renderRoster(el.roomPlayerList, store.members, room, 'player');
        this._renderRoster(el.roomSpectatorList, store.spectators, room, 'spectator');

        const isSpectator = store.isSpectator;
        const isOwner = store.isOwner;
        const countdownActive = Boolean(store.countdown);
        const inCountdown = store.gameState === 'countdown';

        setHidden(el.readyButton, isSpectator);
        if (!isSpectator) {
            el.readyButton.textContent = store.isReady ? 'Cancel ready' : 'Ready up';
            el.readyButton.classList.toggle('primary-button', !store.isReady);
            el.readyButton.classList.toggle('secondary-button', store.isReady);
        }

        setHidden(el.startGameButton, !isOwner || isSpectator || inCountdown);
        el.startGameButton.disabled = !store.canStart();

        setHidden(el.stopGameButton, !isOwner || !inCountdown);

        setHidden(el.roomSettings, !isOwner);
        if (isOwner) {
            el.roomSettings.classList.add('is-open');
            this._populateSettings(room);
        }

        this._renderRoomHint(store, isOwner, isSpectator);
        this._renderCountdown(countdownActive || inCountdown, store.countdown, room);
    }

    _renderRoomHint(store, isOwner, isSpectator) {
        let hint = '';
        if (isSpectator) {
            hint = 'You are spectating. The owner starts the match when everyone is ready.';
        } else if (isOwner) {
            if (store.members.length < store.minPlayers) {
                hint = 'Waiting for at least ' + store.minPlayers + ' players.';
            } else if (!store.members.every((member) => member.ready)) {
                const ready = store.members.filter((member) => member.ready).length;
                hint = ready + ' of ' + store.members.length +
                    ' players ready. Start unlocks when everyone is ready.';
            } else {
                hint = 'Everyone is ready. Start the match when you are.';
            }
        } else if (!store.isReady) {
            hint = 'Ready up when you are set. The owner can start once everyone is ready.';
        } else {
            hint = 'You are ready. Waiting for the room owner to start the match.';
        }

        setText(this.elements.roomHint, hint);
    }

    _renderRoster(list, members, room, role) {
        if (!list) {
            return;
        }

        list.textContent = '';
        if (members.length === 0) {
            const empty = document.createElement('li');
            empty.className = 'notice';
            empty.textContent = role === 'spectator'
                ? 'No spectators yet.'
                : 'No players yet.';
            list.appendChild(empty);
            return;
        }

        for (const member of members) {
            const item = document.createElement('li');
            item.className = 'roster-row';

            const name = document.createElement('span');
            name.className = 'roster-name';
            const bold = document.createElement('b');
            bold.textContent = member.name + (member.isSelf ? ' (you)' : '');
            name.appendChild(bold);
            item.appendChild(name);

            const badges = document.createElement('span');
            badges.className = 'roster-badges';

            if (this._isOwnerMember(member, room)) {
                badges.appendChild(this._badge('Owner', 'badge--owner'));
            }

            if (role === 'spectator') {
                badges.appendChild(this._badge('Spectator'));
            } else if (member.alive === false) {
                badges.appendChild(this._badge('Eliminated', 'badge--dead'));
            } else {
                badges.appendChild(this._badge(
                    formatMemberStatus(member),
                    member.ready ? 'badge--ready' : 'badge--not-ready'
                ));
            }

            item.appendChild(badges);
            list.appendChild(item);
        }
    }

    _isOwnerMember(member, room) {
        if (room.ownerAccountId !== null && room.ownerAccountId !== undefined) {
            return member.id === 'account:' + room.ownerAccountId;
        }
        return Boolean(member.isSelf && room.isOwner);
    }

    _badge(text, modifier) {
        const badge = document.createElement('span');
        badge.className = 'badge' + (modifier ? ' ' + modifier : '');
        badge.textContent = text;
        return badge;
    }

    _populateSettings(room) {
        const el = this.elements;
        const key = room.id + '|' + room.updatedAt;
        const form = el.roomSettingsForm;
        if (form && form.contains(document.activeElement)) {
            return;
        }
        if (this._settingsKey === key) {
            return;
        }
        this._settingsKey = key;

        const settings = room.settings || {};
        setValue(el.settingName, room.name);
        setValue(el.settingVisibility, room.visibility);
        setValue(el.settingMaxPlayers, settings.maxPlayers === undefined ? '' : settings.maxPlayers);
        setValue(el.settingMapWidth, settings.mapWidth === undefined ? '' : settings.mapWidth);
        setValue(el.settingMapHeight, settings.mapHeight === undefined ? '' : settings.mapHeight);
        setValue(el.settingTimeLimit, msToMinutes(settings.timeLimitMs));
        setValue(el.settingScoreLimit, settings.scoreLimit === undefined ? '' : settings.scoreLimit);
    }

    _renderCountdown(visible, countdown, room) {
        const el = this.elements;
        if (!visible || !countdown || !countdown.startsAt) {
            this._clearCountdown();
            return;
        }

        setHidden(el.roomCountdown, false);
        this.countdownStartsAt = countdown.startsAt;
        this._tickCountdown();

        if (!this.countdownTimer) {
            this.countdownTimer = window.setInterval(() => this._tickCountdown(), 250);
        }

        if (room) {
            this.renderRoomCountdownOnly = true;
        }
    }

    _tickCountdown() {
        if (!this.countdownStartsAt) {
            return;
        }

        const remaining = countdownRemaining(this.countdownStartsAt, Date.now());
        setText(this.elements.roomCountdownValue, formatCountdown(remaining));

        if (remaining <= 0) {
            // Keep the panel visible at 0 until gameStart or gameState arrives.
            return;
        }
    }

    _clearCountdown() {
        if (this.countdownTimer) {
            window.clearInterval(this.countdownTimer);
            this.countdownTimer = null;
        }
        this.countdownStartsAt = null;
        setHidden(this.elements.roomCountdown, true);
    }

    showGameOver(result, options = {}) {
        const el = this.elements;
        setHidden(el.gameOverOverlay, false);
        setText(el.gameOverTitle, formatResultTitle(result));
        setText(el.gameOverSubtitle, formatResultSubtitle(result));

        el.gameOverScores.textContent = '';
        for (const entry of resultEntries(result)) {
            const row = document.createElement('li');
            row.className = 'score-row' + (entry.winner ? ' score-row--winner' : '');

            const rank = document.createElement('span');
            rank.className = 'score-rank';
            rank.textContent = formatRank(entry.rank);
            row.appendChild(rank);

            const name = document.createElement('span');
            name.className = 'score-name';
            name.textContent = entry.name;
            row.appendChild(name);

            const score = document.createElement('span');
            score.className = 'score-value';
            score.textContent = formatScore(entry.score);
            row.appendChild(score);

            el.gameOverScores.appendChild(row);
        }

        const isOwner = Boolean(options.isOwner);
        const inRoom = Boolean(options.inRoom);
        setHidden(el.returnToLobbyButton, !isOwner);
        setHidden(el.returnToLobbyHint, !inRoom || isOwner);
        setHidden(el.leaveAfterGameButton, !inRoom);
        el.returnToLobbyButton.disabled = false;
    }

    hideGameOver() {
        setHidden(this.elements.gameOverOverlay, true);
    }

    setReturningToLobby() {
        const button = this.elements.returnToLobbyButton;
        if (button) {
            button.disabled = true;
            button.textContent = 'Returning…';
        }
    }

    resetReturnToLobby() {
        const button = this.elements.returnToLobbyButton;
        if (button) {
            button.disabled = false;
            button.textContent = 'Return to room';
        }
    }
}

module.exports = AppUI;
