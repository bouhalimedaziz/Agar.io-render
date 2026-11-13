# Demo and Testing Guide

This project uses **raw TCP** for all game traffic. The client must run inside
**Electron**, because browsers cannot open raw TCP connections. The HTTP server
only serves static client assets.

---

## Prerequisites

- Node.js and npm
- A graphical desktop session for Electron
- Optional for headless Linux: `xvfb-run`

Install dependencies once:

```bash
npm install
```

---

## Quick automated check

Run everything in this order:

```bash
npm test
npm run build
npm run test:e2e
npm run test:e2e:ui
```

| Command | What it tests |
| --- | --- |
| `npm test` | Lint plus all Mocha unit and integration tests in `test/` |
| `npm run build` | Builds `bin/` and runs the test suite again |
| `npm run test:e2e` | Starts a real server, launches Electron, and tests the TCP protocol flow |
| `npm run test:e2e:ui` | Drives the actual UI: auth, lobby, rooms, match, results, logout, guest play |

`npm run build` must succeed before either E2E command, because both run against
the built files in `bin/`.

### Headless Linux

If there is no display available:

```bash
xvfb-run -a npm run test:e2e
xvfb-run -a npm run test:e2e:ui
```

### Packaging check

To verify the desktop package builds:

```bash
npm run package
```

The output is written to:

```text
dist/OpenAgar-<platform>-<arch>
```

---

## Manual demo

### 1. Start the server

In the first terminal:

```bash
npm start
```

This builds the app and starts:

- the HTTP asset server, usually `http://localhost:3000`
- the TCP game listener, usually `127.0.0.1:3001`

Do not open the game in a normal browser tab. It cannot connect over TCP.

### 2. Start the first client

In a second terminal:

```bash
npm run electron
```

Or rebuild and launch in one step:

```bash
npm run electron:dev
```

### 3. Demo flow with one player

1. Register a new account, or choose **Continue as guest**.
2. Create a room from the lobby.
3. Change the room settings as the owner.
4. Mark yourself ready.
5. Test legacy quick play and spectate from the lobby.
6. Return to the lobby and log out.

### 4. Demo flow with two players

1. Keep the server running.
2. Start a second Electron client with a separate profile so the two windows do
   not share the same saved account token:

   ```bash
   npm run electron -- --user-data-dir=/tmp/agar-player2
   ```

3. Register a second account, or continue as a second guest.
4. Player A creates a room and shares the room code.
5. Player B joins using the room code or the lobby list.
6. Both players ready up.
7. Player A starts the match.
8. Verify:
   - movement and viewport updates
   - food consumption and growth
   - split and fire-food actions
   - chat and ping command
   - leaderboard and score updates
   - match end and final scores
   - return to lobby
9. Close one client and verify the other player sees the disconnect state.
10. Reopen the client, sign in again, and verify the room/session resumes.

### 5. Spectator demo

1. With two players in a room, open a third client.
2. Join the room as a spectator.
3. Verify the spectator sees the game but has no playable cell.

---

## Configuration

Server:

```bash
PORT=3000
TCP_HOST=127.0.0.1
TCP_PORT=3001
AGAR_DB_FILE=/tmp/agar-demo.sqlite3
```

Electron client:

```bash
AGAR_SERVER_HOST=127.0.0.1
AGAR_SERVER_PORT=3001
```

Example with non-default ports:

```bash
# Terminal 1
PORT=4000 TCP_PORT=4001 AGAR_DB_FILE=/tmp/agar-demo.sqlite3 npm start

# Terminal 2
AGAR_SERVER_PORT=4001 npm run electron
```

---

## Troubleshooting

### `Missing bin/server/server.js` or `Missing bin/client/index.html`

Run the build first:

```bash
npm run build
```

### Electron fails to start in a headless environment

Use `xvfb-run`, for example:

```bash
xvfb-run -a npm run electron
```

If running as root, Electron may require `--no-sandbox`; the E2E runner adds it
automatically when needed.

### Port already in use

Choose different ports with `PORT` and `TCP_PORT`, then point the client at the
TCP port with `AGAR_SERVER_PORT`.

### The browser page loads but never connects

This is expected. The game has no browser transport. Use the Electron client.

---

## Useful files

- `test/` — unit and integration tests
- `e2e/run.js` — protocol E2E runner
- `e2e/ui-main.js` — UI-driven E2E scenario
- `src/electron/tcp-bridge.js` — main-process TCP bridge used by Electron
- `src/shared/tcp-socket/` — TCP framing, client, and server implementation
- `src/server/transport/` — server transport hub
