# Backend — the shared Claude server (how this app talks to it)

The "brain" — a Node/Express service that turns an HTTP chat request into a **subscription-
billed** Claude call, streamed back over SSE — used to live in this project as `server/`. It
doesn't anymore: it's a **shared, multi-project resource**, not something this app owns.

- **Source of truth:** `../hf-space` (a sibling folder, its own git repo).
- **Live deployment:** [`https://roanjtaylor-claudesubscription.hf.space`](https://roanjtaylor-claudesubscription.hf.space)
  — visit `/` for the server's own landing page, which lists every project currently
  authorized to call it and explains its env vars.
- **Other callers:** TasteTrainer (a separate, unrelated project) also calls this same server
  for its own AI curation work, using its own shared secret. Editing the server for this
  app's needs can affect that project too — check the landing page before assuming a change
  is safe.
- **To change the server itself** (new endpoint, model default, timeout, etc.): edit in
  `../hf-space`, commit, and `git push` from there. This app has no local copy to keep in
  sync and no deploy automation of its own anymore — that lived here as `scripts/deploy-hf.sh`
  + a `pre-push` hook, both removed once the server stabilized and this app stopped needing
  to change it directly.

## How this app calls it

- **Auth:** every non-health request needs an `x-app-secret` header. This app's value lives
  in the Space's `iphoneAppSecretKey` secret (see the landing page) — the app holds the
  matching value in its own config, kept separate from other callers' secrets so it can be
  rotated independently.
- **Subscription auth, not API:** the server has no `ANTHROPIC_API_KEY` set, so Claude calls
  spend the owner's Claude subscription usage, not metered API credits.
- **Model:** `claude-opus-4-8` default, but this app can pass a per-request `model` and
  `systemPrompt` (from the app's Settings).
- **Tools:** the server allows `WebSearch`/`WebFetch` only — enough for web-aware answers,
  nothing that touches its host filesystem or shell.
- **Conversation & attachments:** the server is stateless — this app sends the full message
  history (incl. every turn's attachment bytes) on every request.

## API (as this app uses it)

| Method | Path | Notes |
| --- | --- | --- |
| `GET`  | `/api/health` | `{ ok: true }`. Public (no secret) — liveness check. |
| `POST` | `/api/chat`   | Body `{ messages: [{role, content, attachments?}], model?, systemPrompt?, projectContext? }`. Streams SSE: `delta {text}` · `tool {name,query?}` · `sources {sources}` … then `done {}` (or `error {error}`). Aborts on client disconnect. Requires `x-app-secret`. |
| `POST` | `/api/title`  | Body `{ user, assistant?, model? }` → `{ title }`. Auto-names a chat after its first exchange. Requires `x-app-secret`. |
| `GET`  | `/api/models` | `{ models }` — the live Anthropic model list for the subscription, so new releases appear in the picker without an app update. Requires `x-app-secret`. |

JSON body limit is **15 mb** (base64 attachments inflate ~33%).

Quick live test:

```bash
curl https://roanjtaylor-claudesubscription.hf.space/api/health
curl -N -X POST https://roanjtaylor-claudesubscription.hf.space/api/chat \
  -H 'Content-Type: application/json' -H 'x-app-secret: <this app's secret>' \
  -d '{"messages":[{"role":"user","content":"Say hi."}]}'
```

For the full contract, hosting runbook, and every current caller, see `hf-space/README.md` —
that's the canonical doc now, not this file.

## Image embedding — what works and what doesn't

This part stays here rather than moving to `hf-space`'s docs: it's really about what this
*app* needs Claude to produce and how it renders the result, not a property of the server
itself (the server just forwards whatever system prompt this app sends).

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

This is documented in `DEFAULT_SYSTEM_PROMPT`, sent by this app on every request (see
`app/src/api.ts` for where it's built and sent as the `systemPrompt` field above).

### What doesn't work — and why ❌

| Approach | Why it fails |
|---|---|
| Direct CDN URL: `upload.wikimedia.org/wikipedia/commons/9/9a/FILENAME.jpg` | The `9/9a` hash path is derived from an MD5 of the filename. Claude knows the filename but routinely gets the hash segment wrong → 404 → grey box. |
| WebFetch a Wikipedia/Wikimedia page to extract image URLs | Wikimedia blocks server-side HTTP requests (returns 403). The server cannot fetch any `*.wikimedia.org` or `*.wikipedia.org` URL. |
| WebFetch modern media sites (topgear.com, motortrend.com) to extract image URLs | These sites use JavaScript rendering. WebFetch only gets raw HTML, which for JS-heavy sites is a shell with no image tags — Claude sees no image URLs to extract. |
| Telling Claude "only embed URLs from pages you actually fetched" | Since all viable image-hosting sites are either blocked or JS-rendered, Claude can never satisfy this constraint and ends up embedding no images at all. |
| Having Claude narrate its search attempts as the response | When all tool calls fail but the model still produced narration text, the server sends `done` without error. The user sees only the narration — no answer, no images. |

### Client-side image rendering

- `MarkdownMessage.tsx` custom `image` render rule → `MarkdownImage` component → `SavableImage` → RN `<Image>`.
- `SavableImage` sets `backgroundColor: colors.surfaceAlt` on the `<Image>` — this is the grey
  placeholder visible while loading or on failure.
- **No `onError` fallback to a text link** — a failed image shows as a quiet grey box, not a
  broken link. This is intentional: text-link fallbacks made the pre-working state look like
  "images are showing" when they were actually failing silently as links.
- `onLoad` fires when an image loads successfully and sets the aspect ratio for correct sizing.
- Tap → `ImageViewerScreen` (full-screen modal, pinch-to-zoom). Long-press → save/share sheet.
