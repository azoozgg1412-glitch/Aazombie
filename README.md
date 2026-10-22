# ZOMBIES online

Your game plus the server it was missing. One Node process serves the game and runs the 4-player rooms.

    public/    the game (index.html), manifest, service worker, icons, config.js
    server/    server.js (web + WebSocket relay + daily leaderboard API), test.js

## Run it locally
    npm install
    npm start          # http://localhost:8080
    npm test           # protocol test (rooms, joins, reconnect, host handover, API)

Open the page on two devices on the same Wi-Fi (http://<your-computer-ip>:8080), tap MULTIPLAYER, host on one, join with the 4-letter code on the other.

## Put it online (pick one)
**Render (easiest):** push this folder to a GitHub repo -> Render -> New -> Blueprint -> pick the repo. It reads `render.yaml`. You get `https://<name>.onrender.com`. The free plan sleeps after ~15 min idle (first player waits ~30 s) and forgets the leaderboard on restart; the paid plan with a disk (set `DATA_DIR` to the disk path) fixes both.
**Fly.io / Railway / any VPS:** use the included `Dockerfile` (listens on `$PORT`, default 8080). It must be a host that allows WebSockets and runs one instance only (rooms live in memory).

Players just open the URL. On a phone: browser menu -> **Add to Home Screen** (Android: "Install app"). It then opens fullscreen like an app and still plays single player offline.

## Real app-store app (Android APK / iOS)
This needs a computer with Android Studio (and a Mac with Xcode for iOS), so it isn't prebuilt here.
1. Edit `public/config.js`: `window.GAME_SERVER = 'wss://<your-deployed-host>';`
2. In this folder:
       npm i -D @capacitor/cli @capacitor/core @capacitor/android
       npx cap add android
       npx cap sync
       npx cap open android      # build the APK/AAB in Android Studio
   Change `appId` in `capacitor.config.json` to your own (e.g. com.yourname.zombies) before the first `cap add`.

## Shipping updates
Online rooms reject players on a different `BUILD` string (in the game: `const BUILD='coop-6'`). Bump it whenever you change multiplayer behaviour, and bump `CACHE` in `public/sw.js` so installed copies refresh. The service worker loads the page network-first, so players online always get the newest version.

## Server API
- `GET /health` -> `{ok, rooms}`
- `GET /api/daily?day=YYYY-MM-DD` -> today's top 20 `{name, round, kills}`
- `POST /api/daily` `{name, round, kills, mode}` -> submits a score
(The game file you sent doesn't call these yet; your newer versions with the shared daily leaderboard can.)
