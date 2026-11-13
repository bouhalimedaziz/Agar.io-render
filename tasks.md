# Tasks: TCP migration and multiplayer features

This file tracks the TCP transport migration and the multiplayer features listed
below.

Status legend:

- `[x]` done
- `[ ]` not started / remaining

The Electron port is a separate follow-up. It is listed at the end so the
dependency is visible, but it is not part of the current transport/feature
implementation.

---

## Current state

- `[x]` Custom raw TCP module exists in `src/shared/tcp-socket/`.
- `[x]` Framing, event encoding, heartbeat, reconnect, handshake, backpressure
      and server/client wrappers are implemented.
- `[x]` Standalone tests exist in `test/tcp-socket.js` and `test/transport.js`
      (Mocha, plus a manual Node verification script was used while the local
      `node_modules` was incomplete).
- `[x]` Transport layer exists in `src/server/transport/`: the hub wraps TCP
      sockets and broadcasts across connected clients.
- `[x]` The game server starts the TCP listener on its configured port. TCP is
      the only game transport.
- `[x]` Game handlers in `src/server/server.js` now use the transport interface
      instead of touching `io` directly.
- `[x]` The shared TCP module is copied by the gulp build to `bin/shared/`.
- `[x]` TCP settings exist in `config.js` (`config.tcp`).
- `[x]` The client runs in Electron and uses the preload/TCP bridge; there is no
      browser transport fallback.
- `[x]` Account, lobby, room and match-session layers exist on the server and
      power the auth/lobby/room/match UI in `src/client/js/app.js`,
      `src/client/js/app-ui.js` and the stores under `src/client/js/`.
- `[x]` The hub was verified against the real game server: multiple TCP clients
      joined the same map, received updates and exchanged chat.
- `[x]` Server shutdown calls `TransportHub.close()`.

Important constraint: a plain browser cannot open raw TCP connections. The
client therefore runs inside Electron, where the main process owns the socket
and bridges events to the renderer. TCP is the only game transport.

---

## Architecture decisions to settle

These should be decided before the feature work starts.

- `[x]` Migration strategy: Option B adopted. The server uses raw TCP and the
      Electron main process owns the client connection. The legacy browser
      transports have been removed.
- `[x]` Authentication model: username + scrypt password hash + opaque session
      token. Guest play stays available without an account.
- `[x]` Persistence: accounts and sessions live in SQLite. Rooms and live game
      state stay in memory until Phase 2; durable match results can be added
      when scoring lands.
- `[x]` Room ownership and lifecycle rules: owner leaves, owner disconnects,
      empty rooms, private rooms.
- `[x]` Game end rules and scoring formula (time limit, last player standing,
      mass-based score, kills, tie handling).
- `[x]` Reconnect policy: how long a disconnected player keeps their cell and
      room slot before removal.
- `[x]` TCP listener configuration: separate `config.tcp` port/host and
      heartbeat settings are in place.

---

## Phase 0: Foundation and transport integration

### Build and configuration

- `[x]` Add `src/shared/**` to the gulp server build/copy output so
      `bin/server` can require the TCP module.
- `[x]` Add TCP settings to `config.js`: host, port, heartbeat interval,
      heartbeat timeout, max payload, handshake timeout, reconnect policy.
- `[ ]` Define an app-level protocol document: event names, payload shapes,
      error codes and a protocol version exchanged in the handshake.
- `[ ]` Add a graceful shutdown path for the TCP server and all sockets
      (`TransportHub.close()` exists, but the process does not call it yet).

### Transport abstraction

- `[x]` Define a small transport interface used by game logic:
      `on(event)`, `emit(event, ...args)`, `broadcast(event, ...args)`,
      `disconnect()`, `id`, `handshake`.
- `[x]` Implement the interface with `TcpServer`/`TcpSocket`.
- `[x]` The legacy browser transport was removed; TCP is the only game
      transport.
- `[x]` Move `src/server/server.js` game handlers onto the interface instead of
      using `io`/`socket` directly.
- `[x]` Add a transport integration test harness that can create several
      clients and drive full event flows (`test/transport.js`).

### TCP hardening

- `[ ]` Add tests for malformed frames, oversized payloads, reserved events and
      handshake timeouts.
- `[ ]` Add tests for half-open/abruptly closed connections.
- `[ ]` Add connection and payload metrics/logging.
- `[ ]` Decide whether to add TLS support now or defer it.

---

## Phase 1: Player registration and login

### Data and security

- `[x]` Define the account model: account id, username, normalized username,
      password hash, created timestamp, last login.
- `[x]` Define the session model: session token, account id, created/expiry
      timestamps, last seen, reconnect state (`active`/`disconnected`).
- `[x]` Add an `accounts` table and a `sessions` table in `src/server/sql.js`
      (schema shared through `src/server/database.js`).
- `[x]` Add `src/server/repositories/account-repository.js` and
      `src/server/repositories/session-repository.js`.
- `[x]` Hash passwords with Node's built-in `crypto.scrypt` and compare with
      `timingSafeEqual`.
- `[x]` Never log passwords, tokens or full auth payloads.
- `[x]` Reuse `logging-repository` for failed login attempts.
- `[x]` Add basic rate limiting for register/login attempts.

### Protocol and server behavior

- `[x]` Add `register`, `login`, `logout`, `auth`/`resumeSession` events and
      structured `authError` responses.
- `[x]` Accept a session token in the TCP handshake `auth` object.
- `[x]` Validate usernames with the existing nick rules and validate password
      length/format.
- `[x]` Duplicate login behavior: `config.auth.duplicateLogin` defaults to
      `"replace"`, which disconnects the older session. `"reject"` is also
      implemented.
- `[x]` Allow a session to resume after a transport reconnect. Resuming a token
      on a new socket also disconnects the older socket.
- `[x]` Allow guest play if desired, with an explicit non-persistent identity.
- `[x]` Tests: valid register/login, invalid credentials, duplicate username,
      expired token, duplicate login, reconnect resume, rate limiting, logout,
      hashing and session cleanup (`test/auth.js`).

### Client

- `[x]` Registration and login screens (`src/client/index.html`,
      `src/client/js/app-ui.js`).
- `[x]` Token/session persistence across reloads
      (`src/client/js/session-store.js`, localStorage with an in-memory
      fallback).
- `[x]` Auth error display and retry flow (inline form errors; fatal session
      errors clear the stored session and return to the auth screen).
- `[x]` Deferred until the Electron/client port if raw TCP is not available in
      the browser.

### Auth protocol implemented

- Client -> `register` / `login`: `{ username, password }`
- Client -> `auth` / `resumeSession`: token string or `{ token }`
- Server -> `authOk`: `{ account, token, expiresAt, resumed }`
- Server -> `authError`: `{ code, message, details? }`
- Client -> `logout`; server -> `loggedOut`
- TCP clients may also send the token in the handshake `auth` object
  (`createClient({ auth: { token } })`).
- Authenticated players join under their account username; the client-provided
  name is ignored when an account is attached.

---

## Phase 2: Lobby and room creation

- `[x]` Define the room model: id, name, owner/account id, visibility
      (public/private), capacity, status, settings, members, spectators,
      created timestamp.
- `[x]` Define room settings: map size, food/virus limits, mass settings,
      max players, time/score limits.
- `[x]` Add `src/server/rooms/room-manager.js` with `createRoom`, `getRoom`,
      `listRooms`, `updateRoom`, `removeRoom` and cleanup helpers.
- `[x]` Add room ids/join codes and room-name uniqueness rules.
- `[x]` Add `listRooms`, `createRoom`, `updateRoom`, `deleteRoom` protocol
      events.
- `[x]` Broadcast `roomList`, `roomCreated`, `roomUpdated`, `roomRemoved`.
- `[x]` Enforce owner-only room settings changes.
- `[x]` Remove empty rooms after a grace period (`config.rooms`).
- `[x]` Tests: create, list, private room, full room, invalid settings, owner
      permissions, cleanup (`test/rooms.js`).

### Client

- `[x]` Lobby screen with room list and refresh (`src/client/js/app-ui.js`,
      `src/client/js/room-store.js`).
- `[x]` Create-room form and room-settings form (owner-only settings panel).
- `[x]` Empty/loading/error states for the room list and room forms.
- `[x]` Deferred until the Electron/client port.

### Room protocol implemented

- Client -> `listRooms`; server -> `roomList { rooms }`
- Client -> `createRoom { name?, visibility?, settings? }`; server ->
  `roomCreated { room }` (public rooms are also broadcast to others).
- Client -> `updateRoom { id, name?, visibility?, settings? }`; server ->
  `roomUpdated { room }`.
- Client -> `deleteRoom { id }`; server -> `roomRemoved { id, code, name }`.
- Errors are returned as `roomError { code, message, details? }`.
- Room summaries include `id`, join `code`, name, visibility, capacity,
  settings, status, member/spectator counts, timestamps and `isOwner`.
- Private rooms are only listed for their owner. Public-to-private updates
  send `roomRemoved` to other clients; private-to-public updates broadcast
  `roomUpdated`.

---

## Phase 3: Joining and leaving a room

- `[x]` Add `joinRoom` and `leaveRoom` protocol events.
- `[x]` Enforce one active room per player, room capacity and visibility
      rules.
- `[x]` Add room membership state on the player/session.
- `[x]` Send a `roomSnapshot` on join: room settings, members, spectators,
      game status.
- `[x]` Broadcast `playerJoined` / `playerLeft` to room members only.
- `[x]` Support spectators joining/leaving without a playable cell.
- `[x]` Handle owner leaving: transfer ownership or close the room.
- `[x]` Restore room membership on reconnect.
- `[x]` Tests: join success, join full/private room, leave, owner transfer,
      reconnect restore, duplicate joins.

### Join protocol implemented

- Client -> `joinRoom { id | code, asSpectator? }`; server ->
  `roomSnapshot { room, role, restored }`.
- Client -> `leaveRoom`; server -> `roomLeft { id, code, name, reason }`.
- Room occupants receive `playerJoined` / `playerLeft`; other clients do not.
- Private rooms accept the owner, or any client that supplies the join code.
- Members can only be in one room; joining another returns `already_in_room`
  with the current `roomId`.
- Account memberships survive disconnects for
  `config.rooms.disconnectGraceMs` and are restored on reconnect via the
  `roomSnapshot` (`restored: true`). Guest memberships are removed immediately.
- When the owner leaves, ownership transfers to the next member or spectator.
  If the last occupant leaves, the room closes immediately.
- Signing in or out while in a room migrates the membership to the new
  identity.

### Client

- `[x]` Room list join buttons and room lobby view (join/spectate actions and
      code-based joining).
- `[x]` Player list, ready state and leave button, kept in sync from
      `roomSnapshot` plus `playerJoined`/`playerLeft`/`playerReady`/
      `playerReconnect`.
- `[x]` Deferred until the Electron/client port.

---

## Phase 4: Game start and end

- `[x]` Add a `RoomGame`/`GameSession` layer that owns a per-room `Map` and
      game state instead of the current single global map.
- `[x]` Define room/game states: `lobby`, `countdown`, `running`,
      `finished`, `closed`.
- `[x]` Add start requirements: owner starts, minimum players, all ready
      (choose the final rule).
- `[x]` Add a countdown event and prevent input before `gameStart`.
- `[x]` Move `tickGame`, `gameloop`, `sendUpdates`, `tickPlayer`,
      `calculateLeaderboard` and `balanceMass` into per-room intervals.
- `[x]` Scope all broadcasts and updates to the room, not the whole server.
- `[x]` Add `gameStart`, `gameCountdown`, `gameState`, `gameEnd` events.
- `[x]` Define end conditions: last player standing, time limit, score limit,
      owner stop, empty room.
- `[x]` Stop and clean up intervals, map data and player references on end.
- `[x]` Tests: start conditions, countdown, running updates, end conditions,
      cleanup, two rooms running independently.

### Client

- `[x]` Ready-up/start UI and countdown display, with owner-only start/stop
      controls.
- `[x]` Game-over screen and return-to-room flow (non-owners wait for the
      owner to return the room to the lobby).
- `[x]` Deferred until the Electron/client port.

---

## Phase 5: Real-time game actions

- `[x]` Port the existing event handlers to room-scoped sessions:
      `gotit`, `respawn`, `0` (target), `1` (fire food), `2` (split),
      `windowResized`, `playerChat`, `pass`, `kick`, `pingcheck`.
- `[x]` Reject game actions from players not in a running game.
- `[x]` Validate input payloads: finite target coordinates, bounded screen
      sizes, valid split/fire requests.
- `[x]` Keep server authority over mass, movement, collisions and food.
- `[x]` Add basic anti-cheat checks for impossible mass/speed/target values.
- `[x]` Send spectator updates for the room they are watching.
- `[x]` Keep chat and admin actions room-scoped.
- `[x]` Review serialization cost and update rate; avoid resending unchanged
      data where practical.
- `[x]` Tests: movement, split, fire food, virus split, chat, spectator view,
      invalid payloads, actions outside a game.

### Client

- `[x]` Move client calls onto the transport interface.
- `[x]` Keep the existing rendering/input behavior.
- `[x]` The client runs only inside Electron and uses the preload/TCP bridge;
  the browser transport was removed.

---

## Phase 6: Scores and final results

- `[x]` Define scoring: mass, kills, food eaten, survival time, or a weighted
      formula.
- `[x]` Track per-player match stats during a game.
- `[x]` Keep the live leaderboard per room and send it only to room members.
- `[x]` Produce a final-results payload: rankings, winner, duration, each
      player's stats, disconnect/DNF markers.
- `[x]` Handle ties and players who left/disconnected.
- `[x]` Add a `matches` table and a match/player-stats repository.
- `[x]` Persist final results and expose basic player history later.
- `[x]` Tests: ranking order, ties, disconnect during game, winner
      calculation, persistence.

### Client

- `[ ]` Final scoreboard, winner display and rematch/return flow.
- `[ ]` Deferred until the Electron/client port.

---

## Phase 7: Player disconnection handling

Transport-level heartbeat already detects dead TCP peers. App-level handling is
still required.

- `[x]` Remove disconnected sockets from the transport hub and the game's
      socket/spectator maps.
- `[x]` Map a socket disconnect to the player, account session and room.
- `[x]` Remove or mark the player as disconnected according to the reconnect
      policy.
- `[x]` Broadcast `playerDisconnect` only to the affected room.
- `[x]` Add a reconnect grace period that keeps the cell/session reserved.
- `[x]` Restore the player after reconnect if the grace period has not expired.
- `[x]` Handle owner/player disconnect during lobby and during a running game.
- `[x]` Handle server shutdown by notifying clients and cleaning up rooms,
      intervals and timers.
- `[x]` Ensure no timer, interval or socket reference leaks after removal.
- `[x]` Tests: abrupt close, heartbeat timeout, reconnect within grace,
      reconnect after grace, owner disconnect, server shutdown.

### Client

- `[x]` Show reconnect/disconnected state without crashing.
- `[x]` Reconnect and resume when possible.
- `[x]` Pause gameplay while disconnected and resume after reconnect.
- `[x]` Show a shutdown/kicked notice when the server ends the session.

---

## Phase 8: TCP-only transport (complete)

- `[x]` Start the TCP server from the server bootstrap on the configured port.
- `[x]` Replace remaining `io`/`socket` usage in the game logic with the
      transport interface.
- `[x]` Remove the legacy socket packages from `package.json` and the lockfile.
- `[x]` Remove the legacy server setup from `src/server/server.js`; TCP is the
      only game transport.
- `[x]` Remove the browser transport; the client runs through the Electron
      preload/TCP bridge.
- `[x]` Update `README.md`, build scripts and configuration for TCP-only game
      traffic.
- `[x]` Search the repo for legacy transport references and confirm the only
      remaining matches are historical documentation or compatibility comments.
- `[x]` Run the full test suite, build and both multi-client Electron E2E suites
      (`test:e2e` and `test:e2e:ui`).

---

## Phase 9: Electron port (separate follow-up)

This is intentionally after the transport and feature work.

- `[x]` Scaffold the Electron app.
- `[x]` Decide where the game server runs: remote server, or hosted inside the
      Electron main process. The server stays standalone; Electron is a TCP
      client and never hosts game state.
- `[x]` Own the TCP client connection in the Electron main process.
- `[x]` Expose a safe IPC/preload API to the renderer (no raw `net` in the
      renderer).
- `[x]` Bridge the transport events to the renderer and renderer actions back.
- `[x]` Keep `contextIsolation` enabled and Node integration disabled in the
      renderer.
- `[x]` Update the client code to use the IPC bridge instead of the browser
      transport.
- `[x]` Package/build the desktop app.
- `[x]` End-to-end test: login, lobby, room, start, play, finish, disconnect,
      reconnect. Covered by `npm run test:e2e` against a real Electron window,
      the preload bridge and a second raw TCP player.

---

## Cross-cutting quality gates

- `[x]` All new modules have unit tests.
- `[x]` At least one multi-client integration test covers the full lifecycle:
      login -> lobby -> create/join room -> start -> play -> finish ->
      disconnect (`npm run test:e2e` and the UI-driven `npm run test:e2e:ui`).
- `[ ]` No unhandled promise rejections or uncaught exceptions during
      disconnect/error paths.
- `[x]` Lint passes.
- `[x]` No secrets or password material in logs.
- `[x]` Documentation is updated as each public protocol event is added.

---

## Suggested implementation order

1. Settle the transport migration strategy and add the transport interface.
2. Add the shared module to the build and start the TCP server alongside
   Express.
3. Implement accounts/sessions and login.
4. Implement room manager and lobby.
5. Implement room membership.
6. Refactor the game loop into room-scoped game sessions.
7. Port real-time actions.
8. Add scores/final results and persistence.
9. Harden disconnection/reconnect behavior.
10. Remove the legacy Socket.IO transport.
11. Start the Electron port as a separate effort.

---

## Definition of done

- The legacy socket packages are no longer runtime dependencies, and the
  browser client assets, server bootstrap and bundle use only the raw TCP
  transport.
- The server runs TCP as its only game transport, and all game traffic is
  room-scoped.
- Players can register/login, create and join rooms, play a complete game, see
  final scores, and disconnect/reconnect without crashing the server.
- The transport and feature flows are covered by automated tests.
- The Electron client can connect over raw TCP through a safe main-process
  bridge.
