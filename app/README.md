# Claude7 — Expo chat app

A thin React Native (Expo) chat client for the iPhone 7. It calls the always-on Claude server
(`../server`, hosted on Hugging Face Spaces) and streams the reply.

**Full docs:** the app design + the verified TestFlight build/ship runbook live in
[`../plan/frontend.md`](../plan/frontend.md). Architecture overview:
[`../plan/architecture.md`](../plan/architecture.md). Backlog: [`../todo.md`](../todo.md).

## Configure

Config lives in **`app.config.ts`** (`expo.extra`), which reads `SERVER_URL` and
`APP_SHARED_SECRET` from the environment. For local dev, put them in a gitignored **`.env`**:

```sh
# app/.env
SERVER_URL=https://roanjtaylor-claudesubscription.hf.space
APP_SHARED_SECRET=<must match the server's APP_SHARED_SECRET>
```

For production builds, set `APP_SHARED_SECRET` as an **EAS secret**
(`eas env:create --name APP_SHARED_SECRET --value '<secret>' --environment production --visibility secret`).
Either way, the in-app **Settings screen** can override the server URL / secret / model /
system prompt at runtime — no rebuild needed.

For local testing against a server on your laptop, set `SERVER_URL` to your machine's LAN IP
(e.g. `http://192.168.1.20:5174`) — `localhost` from the phone points at the phone.

## Run in development

```bash
npm install
npx expo start
```

## Ship to TestFlight

```bash
npm run ship        # eas build -p ios --profile production --auto-submit
```

Requires `ios.image: "macos-sequoia-15.6-xcode-26.2"` in `eas.json` (Apple mandates the
Xcode 26 / iOS 26 SDK). Full detail and gotchas: [`../plan/frontend.md`](../plan/frontend.md).
