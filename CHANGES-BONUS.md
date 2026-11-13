# Changes made for the demo (on top of the TCP version)

1. **Faster disconnection detection** (requirement: player disconnection)
   - `config.js` and `src/shared/tcp-socket/tcp-socket.js`: heartbeat 1 s, timeout 3 s
     (was 15 s / 10 s: a frozen client took 24 s to be noticed; now about 4 s).
   - `tcp-socket.js` `_sendHeartbeat()`: when the previous PONG is still awaited, wait for the
     pong timer instead of disconnecting at once. Before, the effective timeout was the ping
     interval, so a single late PONG under packet loss would drop a healthy player.
2. **WebSocket transport for the cross-network bonus**
   - `src/shared/ws-socket/ws-server.js`: hand-written RFC 6455 server (handshake, framing,
     masking, fragmentation, close codes, application heartbeat), attached to the HTTP server
     on path `/game` and registered in the existing `TransportHub` next to TCP.
   - `src/client/js/transport/web-bridge.js` + `transport/index.js`: when the page is opened in
     a normal browser (no Electron), the client connects over WebSocket with reconnect,
     heartbeat replies and the same events as the TCP bridge.
   - `config.js`: `ws` section. `src/server/server.js`: creates the WebSocket server.
   - `render.yaml`, `DEPLOY-RENDER.md`: one-click hosting on Render.

Tests: `npm test` (lint + 191 tests) passes. Both Electron e2e tests pass; note that
`npm run test:e2e` already failed about 1 run in 3 before these changes ("timed out waiting
for gameCountdown"), so it is flaky by itself. Verified manually: two browser players over
WebSocket + one raw TCP player in the same room and match; a silent WebSocket client is
dropped after 5 s.

3. `package-lock.json`: refreshed by `npm install`. It was out of sync with `package.json`
   (missing `@types/minimatch`, `@types/node`), so `npm ci` fails; `render.yaml` uses `npm install`.
