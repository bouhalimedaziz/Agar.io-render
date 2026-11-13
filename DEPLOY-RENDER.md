# Cross-network bonus: hosting the game on Render

Render only accepts HTTP(S) from the internet, on one port. The server therefore also
offers a **WebSocket** endpoint (`/game`) on its HTTP port, written by hand on top of
Node's HTTP server (`src/shared/ws-socket/`). The browser client uses it automatically
when the page is opened outside Electron. The game logic is the same: both transports
plug into the same `TransportHub`, so browser players and desktop (raw TCP) players can
even share a room when the server is local.

## Deploy (about 10 minutes)

1. Push this folder to a GitHub repository (public or private). Do not commit `node_modules/` or `bin/`.
2. Sign in to https://render.com (free, GitHub login works).
3. **New > Blueprint**, pick the repository. Render reads `render.yaml` and creates the
   web service `openagar` on the free plan. (Or **New > Web Service** with the same
   build and start commands as in `render.yaml`.)
4. Wait for the build (2-5 minutes): `npm install && npx gulp build` then `node bin/server/server.js`.
   The log should show `WebSocket game endpoint on ws://0.0.0.0:<port>/game`.
5. Open `https://openagar.onrender.com` (your service URL). Register, create a room.
6. On another network (phone hotspot, mobile data, home Wi-Fi), open the same URL,
   register and join with the room code.

## Before the demo

- The free plan **sleeps after 15 minutes without traffic**; the first visit then takes
  about a minute. Open the URL 5 minutes before presenting and keep a tab open.
- Accounts live in SQLite on the instance's disk, which is **wiped on every redeploy or
  restart**: register the demo accounts again after deploying.
- Expect 50-200 ms latency depending on the Render region you picked.

## What to show for the bonus

- Two laptops on **different networks** (one on a phone hotspot) in the same room.
- The browser's DevTools > Network > WS > `game`: the 101 Switching Protocols handshake
  and the JSON event frames.
- `server.js` log on Render: connections arriving with different client IPs
  (taken from `X-Forwarded-For`, because Render's proxy sits in front).

## How it relates to the brief

The bonus asks that at least one version works across different networks and that the
setup is explained. This is the TCP version of the game with WebSocket framing
(WebSocket runs over TCP), used only so a public host will forward the traffic. The raw
TCP and raw UDP versions are unchanged and are what the TCP vs UDP comparison uses.
