# Backend — the Claude server (connection + hosting)

The "brain": a Node/Express service that turns an HTTP chat request into a **subscription-
billed** Claude call, streamed back over SSE. Code lives in [`../server/`](../server). It was
generalised from the sibling `a_TasteTrainer` server (one-shot → multi-turn chat).

## How it connects to Claude

- Uses **`@anthropic-ai/claude-agent-sdk`**'s `query()` function, lazy-loaded on first
  request (`server/src/services/claude.ts`).
- **Subscription auth, not API:** with **no `ANTHROPIC_API_KEY`** set, the SDK spawns the
  Claude Code CLI which authenticates from the subscription's OAuth credentials. Locally
  that's `~/.claude/.credentials.json` (from `claude login`); on the host it's the
  `CLAUDE_CODE_OAUTH_TOKEN` env var (from `claude setup-token`).
- **Model:** `claude-opus-4-8` default (`server/src/config.ts`, override via `CLAUDE_MODEL`),
  but the client may pass a per-request `model` and `systemPrompt` (from the app's Settings).
- **Tools:** `allowedTools: ['WebSearch', 'WebFetch']` — enough to mirror the real app's
  live answers, nothing that touches the host filesystem or shell. `maxTurns: 20` allows
  several search → read round-trips before answering (12 was tight enough that web-heavy
  questions hit the cap). On a terminal `error_max_turns` the server **keeps any answer already
  streamed** rather than erroring it away, and an API error carried in a "success" result (e.g.
  an unreadable/too-small image → "Could not process image") is surfaced verbatim instead of a
  generic process-exit crash. A 180 s timeout + `AbortController` prevents stuck subprocesses;
  the route also **aborts the subprocess when the client disconnects** (stop button / dropped
  connection) via `res` `'close'`.
- **Web-tool visibility:** the stream loop watches for `tool_use` blocks and tool results and
  emits `tool` / `sources` SSE events so the app can show a "Searching the web…" state and
  tappable source links. `DEFAULT_SYSTEM_PROMPT` also asks the model to add inline `[n]`
  citation markers (in citation order, matching the Sources list) when it answers from search;
  the app linkifies them to the corresponding source.
- **Project context:** the request may include a `projectContext` string (the parent project's
  standing context). `buildSystemPrompt()` appends it below the effective system prompt
  (`systemPrompt || DEFAULT_SYSTEM_PROMPT`); with none, behavior is byte-identical to before.
- **Conversation & attachments:** stateless on the server — the app sends the full history each
  request, including every turn's attachment bytes. An all-text conversation is flattened into
  one prompt (the proven fast path). As soon as **any** turn — current or earlier — carries an
  attachment, `server/src/services/claude.ts` switches to the SDK's streaming-input mode and
  builds one user message whose content **interleaves each turn's text with its image/document
  blocks** (`{type:'image'|'document', source:{type:'base64',…}}`), in order. Re-sending every
  turn's blocks is what lets the model still "see" an image from an earlier turn on a follow-up
  question — still `query()`, still subscription auth.

## Image embedding — what works and what doesn't

The app renders `![alt](url)` Markdown images inline. Getting images to actually appear
requires everything in the following chain to work:

### The working approach ✅

Claude embeds **Wikimedia Commons `Special:FilePath` URLs** directly from its training knowledge:

```
https://commons.wikimedia.org/wiki/Special:FilePath/Ferrari_F40.jpg
```

- Claude only needs to know the **filename** (e.g. `Ferrari_F40.jpg`) — not the hash path.
- `Special:FilePath` is a redirect endpoint: Wikimedia looks up the hash and redirects to the
  real CDN URL (`upload.wikimedia.org/…`).
- React Native's `<Image>` follows HTTP redirects automatically, so the image loads.
- Claude's training data knows Wikipedia filenames accurately for famous subjects.
- If the filename is slightly wrong, the app shows a grey placeholder — harmless.

This is documented in `DEFAULT_SYSTEM_PROMPT` in `server/src/services/claude.ts`.

### What doesn't work — and why ❌

| Approach | Why it fails |
|---|---|
| Direct CDN URL: `upload.wikimedia.org/wikipedia/commons/9/9a/FILENAME.jpg` | The `9/9a` hash path is derived from an MD5 of the filename. Claude knows the filename but routinely gets the hash segment wrong → 404 → grey box. |
| WebFetch a Wikipedia/Wikimedia page to extract image URLs | Wikimedia blocks server-side HTTP requests (returns 403). The HF Space server cannot fetch any `*.wikimedia.org` or `*.wikipedia.org` URL. |
| WebFetch modern media sites (topgear.com, motortrend.com) to extract image URLs | These sites use JavaScript rendering. WebFetch only gets raw HTML, which for JS-heavy sites is a shell with no image tags — Claude sees no image URLs to extract. |
| Bash/curl on the server to try alternative access | `allowedTools: ['WebSearch', 'WebFetch']` — the Claude Agent SDK will prompt for approval for any other tool, wasting a turn. Never add Bash to this list. |
| Telling Claude "only embed URLs from pages you actually fetched" | Since all viable image-hosting sites are either blocked or JS-rendered, Claude can never satisfy this constraint and ends up embedding no images at all. |
| Having Claude narrate its search attempts as the response | When all tool calls fail and `gotText === true` (from narration text), the server sends `done` without error. The user sees only the narration — no answer, no images. |

### Client-side image rendering

- `MarkdownMessage.tsx` custom `image` render rule → `MarkdownImage` component → `SavableImage` → RN `<Image>`.
- `SavableImage` sets `backgroundColor: colors.surfaceAlt` on the `<Image>` — this is the grey
  placeholder visible while loading or on failure.
- **No `onError` fallback to a text link** — a failed image shows as a quiet grey box, not a
  broken link. This is intentional: text-link fallbacks made the pre-working state look like
  "images are showing" when they were actually failing silently as links.
- `onLoad` fires when an image loads successfully and sets the aspect ratio for correct sizing.
- Tap → `ImageViewerScreen` (full-screen modal, pinch-to-zoom). Long-press → save/share sheet.

## API

| Method | Path | Notes |
| --- | --- | --- |
| `GET`  | `/api/health` | `{ ok: true }`. Public (no secret) — liveness + keep-warm. |
| `POST` | `/api/chat`   | Body `{ messages: [{role, content, attachments?}], model?, systemPrompt?, projectContext? }`. Streams SSE: `delta {text}` · `tool {name,query?}` · `sources {sources}` … then `done {}` (or `error {error}`). Aborts on client disconnect. Requires `x-app-secret`. |
| `POST` | `/api/title`  | Body `{ user, assistant?, model? }` → `{ title }`. One short non-streaming call to auto-name a chat after its first exchange. Requires `x-app-secret`. |
| `GET`  | `/api/models` | `{ models }` — the live Anthropic model list for this subscription (so new releases appear in the picker without an app update), cached ~1 h with a static fallback (always `200`). Requires `x-app-secret`. |

`/api/models` goes through `server/src/services/oauthApi.ts`, which calls Anthropic's OAuth
`/v1/models` with the host's `CLAUDE_CODE_OAUTH_TOKEN` (no API key, no cost).

JSON body limit is **15 mb** (base64 attachments inflate ~33%).

## Security

A middleware rejects any non-health request whose `x-app-secret` header doesn't match
`APP_SHARED_SECRET`. When that env var is empty (local dev) the gate is open for `curl`.
**On the public host it must always be set.**

## Run it locally

```bash
cd server
npm install
npm run dev                                   # http://localhost:5174
curl http://localhost:5174/api/health         # {"ok":true}
```

Chat test (streams `event: delta` lines):

```bash
curl -N -X POST http://localhost:5174/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Say hi in one sentence."}]}'
```

---

## Hosting runbook — Hugging Face Spaces (free, no card, 16 GB RAM)

> The server runs 24/7 as a **Docker Space** on HF's free CPU instance (2 vCPU / 16 GB RAM —
> ample headroom for the Claude CLI subprocess), **no credit card**. It sleeps after ~48 h of
> no traffic and wakes on the next request. The public URL is guarded by `APP_SHARED_SECRET`.
> Live deployment: **`https://roanjtaylor-claudesubscription.hf.space`** (Space renamed from `iphone-claude` to `ClaudeSubscription`).
>
> Container config lives in `server/Dockerfile` (Node 20, listens on port **7860**) and the
> HF YAML frontmatter at the top of `server/README.md` (`sdk: docker`, `app_port: 7860`).

**One-time setup:**

1. **Mint the subscription token** (laptop, logged into the subscription):
   ```bash
   claude setup-token
   ```
   Keep the token. Invent a long random `APP_SHARED_SECRET` too (e.g. `openssl rand -hex 24`).
2. **Create the Space** at huggingface.co → New → Space → **SDK: Docker**, **CPU basic
   (free)**. Public is fine (the secret guards it).
3. **Add two Secrets** (Settings → Variables and secrets): `CLAUDE_CODE_OAUTH_TOKEN` and
   `APP_SHARED_SECRET`. (Never add `ANTHROPIC_API_KEY` — that switches to paid billing.)
4. **Push the server code** to the Space's git repo (clone it *outside* this project to avoid
   nesting repos), copying in `Dockerfile`, `.dockerignore`, `package*.json`, `tsconfig.json`,
   `README.md`, and `src/`. The push auth uses your HF **write token** as the git password.
   ⚠️ The HF YAML block **must be the first lines of `README.md`** or HF errors with "Missing
   configuration in README".
5. **Wait for the Docker build** → green **Running**.
6. **Test** the live URL:
   ```bash
   curl https://roanjtaylor-claudesubscription.hf.space/api/health
   curl -N -X POST https://roanjtaylor-claudesubscription.hf.space/api/chat \
     -H 'Content-Type: application/json' -H 'x-app-secret: <secret>' \
     -d '{"messages":[{"role":"user","content":"Say hi."}]}'
   ```

**Re-deploys:** copy changed files into the Space clone, `git commit`, `git push`. Updating a
Secret restarts the Space automatically.

**Auto-deploy on push (preferred):** a `pre-push` git hook keeps the Space in sync, so you
don't run the copy/commit/push dance by hand. When you push this repo's **`main`**, the hook
mirrors `server/` into the Space clone (default: a sibling `../hf-space`; override with
`HF_SPACE_DIR`), commits, and pushes to HF — which rebuilds. It's best-effort and only fires
for `main`, so a hosting hiccup never blocks your push to origin and feature branches don't
deploy work-in-progress.

- Scripts: [`../scripts/deploy-hf.sh`](../scripts/deploy-hf.sh) (the mirror+commit+push, also
  runnable by hand: `bash scripts/deploy-hf.sh`) and [`../.githooks/pre-push`](../.githooks/pre-push).
- One-time per clone: `git config core.hooksPath .githooks` (it's local config, not committed).
- Still requires the Space clone to exist (the hook pushes *to* it); the script prints the
  `git clone` command if it's missing.

**Env vars on the host:**

| Var | Purpose |
| --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | Subscription auth for chat/models (from `claude setup-token`). |
| `APP_SHARED_SECRET` | Must match the value baked into the app. |
| `PORT` | `7860` (set in the Dockerfile; HF routes HTTPS to it). |
| `ANTHROPIC_API_KEY` | **Must stay UNSET.** |

> **Note:** there is intentionally no in-app usage display. The real plan-utilization endpoint
> needs the `user:profile` scope, which the long-lived `setup-token` doesn't grant, and the
> profile-scoped refresh-token workaround is too fragile on a free, ephemeral host (rotating
> tokens, no persistent storage, conflicts with the local `claude` login). Check usage with the
> `/usage` command in Claude Code instead.

**Maintenance:** `setup-token` tokens are long-lived (~1 yr) but not eternal. If chat starts
returning auth errors, re-run `claude setup-token` and update the Space's
`CLAUDE_CODE_OAUTH_TOKEN` secret.

**Fallback host:** Render free (no card) also works but caps RAM at 512 MB (OOM risk for the
Claude CLI) and cold-starts after 15 min idle. Stay on HF Spaces unless you hit a wall.
