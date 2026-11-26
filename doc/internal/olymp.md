# Connect Vizint to Olymp

Build and serve Vizint with the current Olymp upstream:

```sh
npm ci
npm run build
OLYMP_ORIGIN=https://gestalter.koljasam.com npm start
```

Open `http://127.0.0.1:8000` and sign in to Olymp from the site. For production static hosting, configure a same-origin reverse proxy for `/v1/*` to `https://gestalter.koljasam.com`, preserving the full path, method, body, and Olymp authentication headers. The browser SDK makes requests to the Vizint origin.

When Olymp moves, confirm outstanding writes have synced and update `OLYMP_ORIGIN` before restarting the Node server, or retarget the production proxy. Keep the public Vizint origin stable so browsers keep their local replica and session. Sign in again if the service rejects the old session.

When moving the service to a new VPS, preserve the Olymp SQLite database and its matching `opaque-setup-v1` from `/var/lib/olymp`. They keep existing accounts and synced data available at the new HTTPS endpoint.
