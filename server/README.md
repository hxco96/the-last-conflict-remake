# Free matchmaking server (optional)

The game itself is a static site and is already hosted free by GitHub Pages. Co-op uses WebRTC, so the only
server needed is a tiny **signaling** server that helps two browsers find each other. By default the game uses
the shared public PeerJS cloud (free, no setup). Running your own is more reliable and never rate-limited.

## Deploy on Render (free, ~3 minutes)

1. Sign in at https://render.com with GitHub.
2. **New → Blueprint** → pick this repository (it reads `render.yaml`) → **Apply**.
3. When it is live, copy the URL (like `tlcr-peer.onrender.com`) and set it in `js/config.js`:

   ```js
   export const BROKER = { host: 'tlcr-peer.onrender.com', port: 443, path: '/', secure: true };
   ```
4. Commit and push; GitHub Pages republishes. Players try your server first and fall back to the public cloud.

Notes: Render's free tier sleeps after ~15 min idle, so the first room after a quiet spell takes ~30-60 s to
wake (the game then falls back to the public cloud while it wakes). Any Node host works the same way
(`cd server && npm install && npm start`; it listens on `$PORT`, default 9000).

## Test locally

```bash
cd server && npm install && PORT=9100 node index.js
# then open the game with ?broker=localhost:9100 on every device/tab
```

Phones on mobile data need a TURN relay when a direct connection is impossible; `js/config.js` ships the free
public Open Relay servers for that.
