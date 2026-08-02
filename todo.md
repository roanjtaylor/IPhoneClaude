# Claude7 — TODO / product backlog

Where the app is today and what's needed next. Design and "why" live in
[`plan/`](plan/ethos.md). Completed work is condensed into **Shipped** below; the live backlog
is **Next sprint** and beyond.

## ✅ Shipped

A navigated, persisted, multi-screen Expo app + a stateless Node/Express SSE server, live on
the iPhone 7 (iOS 15.8.5) via TestFlight, laptop-free (server on HF Spaces), on the **Claude
subscription** (no API cost). What's already built:

**Core chat**
- Real **Claude Opus 4.8** answers, **live SSE token streaming**, **multi-turn** within a
  session (full history resent each turn).
- **Web search + web fetch** with a visible "Searching the web…" banner and tappable source
  chips (`SourcesList.tsx`; server emits `tool` / `sources` SSE events).
- **Stop** button (client `AbortController` + server abort-on-disconnect).
- **Markdown** replies (`MarkdownMessage.tsx`) — headings, bold, lists, links, images,
  horizontally-scrollable tables, and fenced **code blocks** with lightweight highlighting +
  copy (`CodeBlock.tsx`). Plain text while streaming, upgrades to Markdown on completion
  (iPhone-7 perf).
- **Copy / regenerate / share** per reply (`MessageActions.tsx`); **save images** from replies
  to Photos / share (`SavableImage.tsx`); **tap any image to view full-screen** (zoomable modal,
  `ImageViewerScreen.tsx`).
- **Stop → Retry + Continue** — a stopped reply is marked **Stopped** and offers **Retry**
  (regenerate) and **Continue** (resume the same bubble via a transient "keep going" wire turn +
  `updateMessage`, merging sources). (`useChat.ts`, `MessageActions.tsx`.)
- **Inline numbered citations** — the model emits `[n]` markers (system-prompt instruction) and
  the app linkifies them to the matching web source, code-safe (`MarkdownMessage.linkifyCitations`).
- **Share / export a whole conversation** as Markdown via the iOS share sheet
  (`lib/exportConversation.ts`, header ••• menu in `ChatScreen`).
- **Projects** — a parent **goal + standing context** that child chats inherit (injected into
  the system prompt as `projectContext`); `projects` table + `projectId` FK via a
  `user_version` migration (`ProjectsListScreen.tsx`, `ProjectDetailScreen.tsx`).

**Persistence & navigation**
- **SQLite** conversations + messages (`storage/db.ts`); attachment bytes on disk
  (`storage/attachments.ts`). Chat-list home with new / rename / delete (Edit mode + floating
  ＋) and **auto-titling** (`POST /api/title`).
- **Search conversations** — title + message-text search with snippets
  (`db.searchConversations()`), debounced in the list screen.

**Input & multimodal**
- **Attachments** — image (library/camera) + document (PDF/text), downscaled, sent as base64
  content blocks. Client forces a real JPEG re-encode; server **sniffs the true image format
  from magic bytes** (`sniffImageType`) and drops true HEIC with a clear note. (Image analysis
  root-caused & verified end to end.) **Attachments persist across the whole conversation** —
  the client resends every turn's bytes (capped to a wire budget in `useChat.toWire`) and the
  server rebuilds image/document blocks for *every* turn that had them, so a follow-up question
  can still reference an image sent earlier.
- **Code-block height cap** — a single fenced block (e.g. a "markdown art" / ASCII-art reply) is
  capped (`CodeBlock.tsx`, `MAX_BLOCK_HEIGHT`) and scrolls internally, so it can't stretch the
  message bubble down the whole screen and hide following messages + the composer.
- **Pinch-to-zoom** chats + an **Update Fit** header button (bakes zoom into a layout scale).
- Composer keyboard offset uses the real `useHeaderHeight()` so the last messages aren't hidden.

**Settings & polish**
- **Settings screen** — server URL/secret (lock-protected), **dynamic model picker**
  (`GET /api/models`, live Anthropic list, cached 1 h, static fallback), custom instructions,
  **appearance** (System / Light / Dark), **Test connection**. Runtime overrides via
  `SettingsContext` + AsyncStorage (no rebuild).
- **Light/dark theming** — `theme.ts` palettes resolved at runtime by `ThemeContext` from
  `useColorScheme()` or the Settings override; every screen reads `useTheme()`.
- **Wake-from-sleep UX** — "Waking Claude up…" banner + keep-warm `/api/health` ping on focus.
- Haptics + message timestamps; Claude **mascot** on empty states (`ClaudeMascot.tsx`);
  **landscape** orientation; **shared-secret** auth.

**Google Meet**
- **Google Meet via WebView** — Settings screen has a "Join Google Meet" input (accepts bare code
  or full link) that opens a full-screen `WKWebView` with a desktop Chrome user-agent to bypass
  Google's mobile-browser redirect wall. `sharedCookiesEnabled` shares Safari's existing Google
  session so no re-login is needed. ❌ **Does not work** — Google's join-time block goes deeper
  than JS injection. We mask all known Chrome-vs-WebKit fingerprinting signals (`window.webkit`,
  `navigator.vendor`, `navigator.platform`, `navigator.maxTouchPoints`, `ontouchstart`,
  `performance.memory`, `navigator.plugins`, `window.chrome`) but Meet still returns "You can't
  join this video call." The block is likely at the WebRTC SDP / network-client level or a
  server-side policy that no JS patch can reach from a WKWebView.

**Branding / build**
- Custom **logo + icon** (`assets/icon.svg` → `icon.png` 1024², orange burst on white) + splash,
  wired in `app.config.ts`. Re-export with:
  `npx sharp-cli -i ./assets/icon.svg -o ./assets/icon.png resize 1024 1024 -- flatten --background "#FFFFFF"`.
- `appSharedSecret` moved out of `app.json` (deleted) → `app.config.ts` reads it from env
  (`.env` locally, EAS secret for prod).

> All server endpoints validated locally via `curl`; the app bundles cleanly for iOS. The
> Phase-2 refactor reached chat feature-parity with the official Claude app.

---

## 🎯 Next sprint

### 🚦 Gates before the next production build
- [ ] **Rotate `APP_SHARED_SECRET`** on the HF Space (the old value is in git history) and set
      the new value as an EAS secret: `eas env:create --name APP_SHARED_SECRET …`. Local dev
      already reads it from the gitignored `app/.env`.
- [ ] **On-device pass** on the iPhone 7 (Expo Go tunnel, then a TestFlight build): markdown,
      persistence across app kill, attachments, web-search sources, stop, copy/export/regenerate,
      light/dark, dynamic model list, search.

### High priority — close the parity gap
- [ ] **Edit & resubmit a user message** + **branch** from an earlier turn (official lets you
      edit a sent prompt and re-run; we only regenerate the last turn).
- [ ] **Incremental Markdown while streaming** — currently plain text until the turn completes
      (iPhone-7 perf tradeoff). Try throttled (~5–8 fps) live Markdown with `React.memo`, falling
      back to plain on older hardware.
- [ ] **Citation alignment** — `[n]` markers map to sources by *discovery* order (best-effort),
      so a marker can occasionally point at the wrong source. Tighten by having the model emit
      the URL/source mapping, or render `[n]` as a scroll-to-chip instead of an open-URL.

### Medium priority
- [ ] **Response style presets** — Normal / Concise / Explanatory / Formal picker, layered onto
      the per-chat custom instructions (the free-text custom-instructions field already ships).
- [ ] **Pin / archive chats** and basic organization (favourites) in the chat list. (Projects
      now group chats by shared context — see Shipped.)
- [ ] **Project knowledge files** — let a project hold uploaded PDFs/text/images attached as
      context to every chat in it (today projects carry text context only). Watch the 15 MB
      request limit when combined with per-chat images.
- [ ] **Real syntax highlighting** — replace the lightweight tokenizer (`components/highlight.ts`)
      with full language grammars + a theme, if it stays smooth on the iPhone 7.
- [ ] **Attachment polish** — paste an image into the input, attach from the Files app, show
      size/type limits and a clearer per-attachment error. (Historical attachments across turns
      are now handled — see Shipped.)

### Lower priority / larger efforts
- [ ] **Server-side sync (multi-device)** — history is local-only today. Persist conversations
      per-user on the server and sync. Large; only matters beyond one device.
- [ ] **Artifacts** — a preview pane for generated code/HTML/documents.
- [ ] **Voice dictation / voice mode** — mic-to-text input (iOS 15 speech support on RN is
      finicky — spike first).
- [ ] **Push notifications** when a long reply finishes while backgrounded.
- [ ] **Extended-thinking toggle + display** (show/hide reasoning), if exposed by the SDK.

### Explicitly out of scope (for now)
- **Image generation** (Claude can't natively; would need an external paid image API).
- **Account/login & usage-limit UI** — N/A for a single-user, shared-secret app.

## Phase 3 (separate effort)
- [ ] **Code from the phone** — drive Claude Code against a GitHub repo on the same server to
      edit/commit/push. See [`plan/ethos.md`](plan/ethos.md).
