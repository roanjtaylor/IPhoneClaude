// Talks to Claude via the Claude Agent SDK, using whatever credentials the
// environment already has. With NO ANTHROPIC_API_KEY set, the SDK uses the Claude
// subscription login — locally the OAuth token in ~/.claude/.credentials.json (from
// `claude login`), and on a headless cloud host the CLAUDE_CODE_OAUTH_TOKEN env var
// (from `claude setup-token`). Either way usage draws on the PLAN, not pay-per-use
// API credits. If ANTHROPIC_API_KEY *is* set, the SDK prefers it and bills credits.
// No key is hardcoded here. (See plan/backend.md.)
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_MODEL } from '../config.ts';

// The Agent SDK doesn't call an HTTP API directly — it spawns a full Claude Code CLI
// subprocess. By default that CLI does non-essential network work on startup
// (refreshing marketplaces, auto-updating) which can stall for minutes on some
// networks. We need none of it, so disable it. Setting these on process.env (not
// options.env) means the spawned CLI inherits them; subscription auth is unaffected.
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ??= '1';
process.env.DISABLE_AUTOUPDATER ??= '1';

// The SDK is loaded LAZILY (on first request), never at module top-level, wrapped in
// a timeout. It's a heavy module that spawns a CLI; deferring it keeps server boot
// instant, and a misbehaving load fails one request instead of taking down the
// backend. `type` is erased at runtime, so this keeps `query`'s types WITHOUT
// triggering the real import.
type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk');
type QueryFn = SdkModule['query'];
type SDKUserMessage = Parameters<QueryFn>[0]['prompt'] extends string | AsyncIterable<infer U>
  ? U
  : never;
let cachedQuery: QueryFn | null = null;

/** Reject `p` if it hasn't settled within `ms`, turning a hang into a clear error. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms.`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Load (once) and cache the SDK's `query`. */
async function getQuery(): Promise<QueryFn> {
  if (cachedQuery) return cachedQuery;
  const mod = await withTimeout(
    import('@anthropic-ai/claude-agent-sdk'),
    20_000,
    'Loading the Claude Agent SDK',
  );
  cachedQuery = mod.query;
  return cachedQuery;
}

// The spawned Claude CLI scribbles working files into its cwd. Point it at a scratch
// dir OUTSIDE any project so it never picks up a repo's CLAUDE.md and so file-watchers
// (in dev) don't see those writes and restart mid-request.
const CLAUDE_CWD = path.join(os.tmpdir(), 'iphone-claude-cwd');
let claudeCwdReady = false;
async function ensureClaudeCwd(): Promise<string> {
  if (!claudeCwdReady) {
    await fs.mkdir(CLAUDE_CWD, { recursive: true });
    claudeCwdReady = true;
  }
  return CLAUDE_CWD;
}

// A plain conversational system prompt so the model behaves like the Claude chat app.
export const DEFAULT_SYSTEM_PROMPT = [
  'You are Claude, a helpful, friendly AI assistant made by Anthropic.',
  'Respond conversationally and helpfully, like the Claude app does.',
  'Use the web search tool when the user asks about current events, recent releases,',
  'prices, or anything where up-to-date information matters; otherwise answer directly',
  'from your own knowledge. Format answers in clean Markdown.',
  'When your answer relies on web search results, add inline citation markers like [1] or',
  '[2] right after the sentence or claim each one supports, numbered in the order you first',
  'cite them — these numbers line up with the Sources list shown to the user. Only cite',
  'sources you actually used; never invent citation numbers, and skip citations entirely',
  'when you did not search.',
  'You only have WebSearch and WebFetch tools — do NOT attempt Bash or curl.',
  'The app renders Markdown images: ![alt text](url). Embed images when they add value.',
  'Use Wikimedia Commons Special:FilePath URLs — they only need the filename, not the',
  'hash path, so they are reliable from training knowledge:',
  'https://commons.wikimedia.org/wiki/Special:FilePath/FILENAME.jpg',
  'Example: https://commons.wikimedia.org/wiki/Special:FilePath/Ferrari_F40.jpg',
  'Use underscores for spaces and keep the exact Wikipedia filename capitalisation.',
  'The app follows redirects and shows a grey placeholder for any URL that fails, so a',
  'wrong filename is harmless. Embed 2-4 images per response. You do NOT need to',
  'WebFetch anything to verify image URLs — use your training knowledge directly.',
].join(' ');

/** A base64-encoded attachment travelling with a user turn. */
export type Attachment = {
  type: 'image' | 'document';
  /** e.g. "image/jpeg", "application/pdf". */
  mediaType: string;
  /** Raw base64 (no data: prefix). */
  data: string;
};

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
  attachments?: Attachment[];
};

export type StreamCallbacks = {
  onDelta: (text: string) => void;
  /** Fired when Claude starts a web tool (search/fetch). */
  onTool?: (info: { name: string; query?: string }) => void;
  /** Fired with source links discovered while answering. */
  onSources?: (sources: { url: string; title?: string }[]) => void;
};

export type StreamOptions = {
  model?: string;
  systemPrompt?: string;
  /** Parent-project context, appended after the (custom or default) system prompt. */
  projectContext?: string;
  /** Extended thinking: give the model a reasoning budget before it answers. */
  thinking?: boolean;
  /** Abort from the caller (e.g. client disconnected). */
  signal?: AbortSignal;
};

/**
 * Compose the effective system prompt. Backwards-compatible: with no projectContext this is
 * exactly the prior behavior (`systemPrompt || DEFAULT_SYSTEM_PROMPT`); a project simply
 * appends its standing context below whichever base prompt is in effect.
 */
function buildSystemPrompt(options: StreamOptions): string {
  const base = options.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const ctx = options.projectContext?.trim();
  return ctx
    ? `${base}\n\nProject context (applies to all chats in this project):\n${ctx}`
    : base;
}

/**
 * Flatten prior conversation turns into a text preamble. The newest message (the
 * current user turn) is handled separately so its attachments can ride along as
 * structured content blocks. Used only on the all-text fast path; when ANY turn in the
 * conversation carries an attachment we build interleaved content blocks instead so that
 * earlier images/documents stay visible to the model (see buildUserContent).
 */
function buildHistoryPreamble(messages: ChatMessage[]): string {
  const prior = messages.slice(0, -1);
  if (prior.length === 0) return '';
  const history = prior
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n');
  return `Conversation so far:\n${history}\n\nUser: `;
}

// Media types Claude's vision can actually read.
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * Sniff the ACTUAL image format from the first bytes of the base64 payload, ignoring the
 * client-declared media type. This is the crux of the "Claude can't see my photo" bug: an
 * iPhone-library photo is often HEIC, and if it reaches us mislabeled as image/jpeg the
 * model silently can't read it. By detecting the true format we (a) fix wrong labels, and
 * (b) recognize HEIC so we can drop it with a clear log instead of sending dead bytes.
 * Returns the correct media type, 'heic' if it's unreadable HEIF/HEIC, or null if unknown.
 */
function sniffImageType(base64: string): string | null {
  let head: Buffer;
  try {
    head = Buffer.from(base64.slice(0, 64), 'base64');
  } catch {
    return null;
  }
  if (head.length < 12) return null;
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png';
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return 'image/gif';
  if (
    head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
    head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50
  )
    return 'image/webp';
  // ISO-BMFF 'ftyp' box (bytes 4-7) → HEIC/HEIF family (brands heic/heix/hevc/mif1/msf1).
  if (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) {
    const brand = head.toString('ascii', 8, 12);
    if (/heic|heix|hevc|heif|mif1|msf1/i.test(brand)) return 'heic';
  }
  return null;
}

/**
 * Append one attachment to a content-block array as an image/document block. Trusts the
 * sniffed bytes over the client label. True HEIC can't be read by the model, so instead of
 * sending dead bytes we drop it and push a short note so the model knows it was there.
 */
function pushAttachmentBlock(blocks: unknown[], a: Attachment): void {
  if (a.type === 'image') {
    const sniffed = sniffImageType(a.data);
    if (sniffed === 'heic') {
      console.warn('[chat] dropping HEIC image — convert to JPEG/PNG before sending.');
      blocks.push({
        type: 'text',
        text: '(Note: an attached image could not be read because it was in HEIC format and was not converted to JPEG.)',
      });
      return;
    }
    const media_type = sniffed ?? (IMAGE_TYPES.has(a.mediaType?.toLowerCase()) ? a.mediaType.toLowerCase() : 'image/jpeg');
    blocks.push({ type: 'image', source: { type: 'base64', media_type, data: a.data } });
    return;
  }
  const media_type = (a.mediaType || 'application/pdf').toLowerCase();
  blocks.push({ type: 'document', source: { type: 'base64', media_type, data: a.data } });
}

/**
 * Build the Anthropic content for the request.
 *
 * Fast path: when NO turn carries an attachment, return a single flattened string (the
 * proven all-text path).
 *
 * Attachment path: when any turn — current OR earlier — has an attachment, build one user
 * message whose content interleaves each turn's text with its image/document blocks, in
 * order. This is the fix for "Claude can't see the image I sent last turn": the server is
 * stateless and the app resends full history with every turn's bytes, but we previously only
 * attached the CURRENT turn's files and flattened the rest to text — so any image from an
 * earlier turn vanished. Re-sending every turn's blocks keeps the whole conversation visible.
 */
function buildUserContent(messages: ChatMessage[]): string | unknown[] {
  const last = messages[messages.length - 1];
  const lastAtts = last.attachments ?? [];
  // The Anthropic API rejects empty text blocks, and a blank caption gives the model no
  // instruction. When the turn is attachments-only, substitute a sensible default ask so the
  // request is valid AND the model actually engages with the image/document.
  const body =
    last.content.trim().length > 0
      ? last.content
      : lastAtts.length > 0
        ? 'Please look at the attached file(s) and describe what you see.'
        : last.content;

  const anyAttachments = messages.some((m) => (m.attachments?.length ?? 0) > 0);
  if (!anyAttachments) return `${buildHistoryPreamble(messages)}${body}`;

  const totalAtts = messages.reduce((n, m) => n + (m.attachments?.length ?? 0), 0);
  console.log(
    `[chat] ${totalAtts} attachment(s) across ${messages.length} turn(s):`,
    messages
      .flatMap((m) => m.attachments ?? [])
      .map((a) => `${a.type}/${a.mediaType}(${Math.round((a.data?.length ?? 0) / 1366)}KB)`)
      .join(', '),
  );

  const blocks: unknown[] = [];
  const prior = messages.slice(0, -1);
  if (prior.length > 0) {
    blocks.push({ type: 'text', text: 'Conversation so far:' });
    for (const m of prior) {
      const label = m.role === 'user' ? 'User' : 'Assistant';
      const content = m.content.trim().length > 0 ? m.content : '(no text)';
      blocks.push({ type: 'text', text: `${label}: ${content}` });
      for (const a of m.attachments ?? []) pushAttachmentBlock(blocks, a);
    }
    blocks.push({ type: 'text', text: `User: ${body}` });
  } else {
    blocks.push({ type: 'text', text: body });
  }
  for (const a of lastAtts) pushAttachmentBlock(blocks, a);
  return blocks;
}

/**
 * Turn the conversation into the `prompt` argument for query(). With no attachments
 * this is a plain string (the proven path). With attachments it's a one-shot async
 * iterable yielding a single user message whose content carries the image/document
 * blocks — the SDK's streaming-input mode (see plan: SDKUserMessage.message = MessageParam).
 */
function buildPrompt(messages: ChatMessage[]): string | AsyncIterable<SDKUserMessage> {
  const content = buildUserContent(messages);
  if (typeof content === 'string') return content;

  const sessionId = randomUUID();
  async function* gen(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: 'user',
      message: { role: 'user', content: content as any },
      parent_tool_use_id: null,
      session_id: sessionId,
    } as SDKUserMessage;
  }
  return gen();
}

/** Pull http(s) URLs out of an arbitrary tool-result payload, for source links. */
function extractUrls(value: unknown, into: Map<string, { url: string; title?: string }>): void {
  if (value == null) return;
  if (typeof value === 'string') {
    const re = /https?:\/\/[^\s"'<>)\]]+/g;
    for (const m of value.matchAll(re)) {
      const url = m[0].replace(/[.,;]+$/, '');
      if (!into.has(url)) into.set(url, { url });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) extractUrls(v, into);
    return;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Common shapes: { url, title } from web_search results.
    if (typeof obj.url === 'string') {
      const url = obj.url;
      const title = typeof obj.title === 'string' ? obj.title : undefined;
      if (!into.has(url)) into.set(url, { url, title });
    }
    for (const v of Object.values(obj)) extractUrls(v, into);
  }
}

const WEB_TOOL_NAMES = ['WebSearch', 'WebFetch', 'web_search', 'web_fetch'];
function isWebTool(name: unknown): boolean {
  return typeof name === 'string' && WEB_TOOL_NAMES.some((n) => name.includes(n));
}

/**
 * Stream a multi-turn chat reply. Calls callbacks.onDelta with each chunk of assistant
 * text as it is generated. Surfaces web-tool activity via onTool/onSources. Resolves
 * when the reply is complete; rejects on error, timeout, or abort.
 */
export async function streamChat(
  messages: ChatMessage[],
  callbacks: StreamCallbacks,
  options: StreamOptions = {},
): Promise<void> {
  const query = await getQuery();
  const cwd = await ensureClaudeCwd();
  const prompt = buildPrompt(messages);

  // Each query() spawns a Claude Code CLI subprocess. The timeout below only RACES the
  // call; the abortController is what actually tears the subprocess down (in finally),
  // so a stuck call can't leave an orphaned child running. An external signal (client
  // disconnect) is chained in so the subprocess dies promptly when the phone hangs up.
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const seenSources = new Map<string, { url: string; title?: string }>();
  // Track whether the model produced any visible answer text, so a terminal "ran out of
  // steps" result keeps the partial answer instead of erroring it away.
  let gotText = false;

  const consume = async (): Promise<void> => {
    for await (const message of query({
      prompt,
      options: {
        model: options.model || CLAUDE_MODEL,
        systemPrompt: buildSystemPrompt(options),
        // Allow only web tools — enough to mirror the real app, nothing that touches
        // the host filesystem or shell.
        allowedTools: ['WebSearch', 'WebFetch'],
        // Permit several tool round-trips (search -> read -> search -> answer). 12 was tight
        // enough that web-heavy questions hit the cap and errored; 20 gives real headroom.
        maxTurns: 20,
        // Stream partial output so the UI fills in live instead of waiting.
        includePartialMessages: true,
        // Extended thinking (opt-in from the app's model sheet). Thinking deltas are
        // NOT forwarded as answer text — only text_delta events reach onDelta below.
        maxThinkingTokens: options.thinking ? 8192 : undefined,
        cwd,
        abortController: controller,
      },
    })) {
      if (message.type === 'stream_event') {
        const ev = (message as any).event;
        // The model's visible answer arrives as text_delta events; forward each one.
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          gotText = true;
          callbacks.onDelta(ev.delta.text as string);
        } else if (ev?.type === 'content_block_start') {
          const block = ev.content_block;
          if ((block?.type === 'tool_use' || block?.type === 'server_tool_use') && isWebTool(block.name)) {
            callbacks.onTool?.({ name: block.name, query: block.input?.query });
          } else if (block?.type === 'thinking') {
            // Let the app show a "Thinking…" banner while the reasoning block runs.
            callbacks.onTool?.({ name: 'Thinking' });
          }
        }
      } else if (message.type === 'assistant') {
        // Complete assistant turn — detect tool_use blocks the partial stream missed.
        const blocks = (message as any).message?.content;
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            if ((b?.type === 'tool_use' || b?.type === 'server_tool_use') && isWebTool(b.name)) {
              callbacks.onTool?.({ name: b.name, query: b.input?.query });
            }
          }
        }
      } else if (message.type === 'user') {
        // Tool results flow back as user messages; mine them for source URLs.
        const blocks = (message as any).message?.content;
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            if (b?.type === 'tool_result' || b?.type === 'web_search_tool_result') {
              const before = seenSources.size;
              extractUrls(b.content ?? b, seenSources);
              if (seenSources.size > before) {
                callbacks.onSources?.([...seenSources.values()]);
              }
            }
          }
        }
      } else if (message.type === 'result') {
        // The terminal message. Decide whether it's a real failure worth surfacing.
        const subtype = (message as any).subtype;
        const isError = (message as any).is_error === true;
        const resultText = String((message as any).result ?? '').trim();
        if (subtype === 'success') {
          // A "success" envelope can still carry an API error (e.g. an unreadable/too-small
          // image returns `is_error` with the API message in `result`). Surface that text so
          // the user sees the real reason instead of a generic process crash.
          if (isError && resultText) throw new Error(resultText);
        } else if (subtype === 'error_max_turns') {
          // Hit the step cap (usually repeated web searches). Keep any answer already streamed;
          // only error when nothing was produced at all.
          if (!gotText) {
            throw new Error(
              'Claude took too many steps (e.g. repeated web searches) before answering. Please retry or simplify the request.',
            );
          }
        } else if (subtype) {
          throw new Error(`Claude returned: ${subtype}`);
        }
      }
    }
  };

  try {
    // A healthy reply (incl. a web search) finishes well inside this; the cap turns a
    // stuck call into a clear error rather than an indefinite hang.
    await withTimeout(consume(), 180_000, 'Claude chat');
  } finally {
    options.signal?.removeEventListener('abort', onExternalAbort);
    controller.abort();
  }
}

/**
 * One-shot, non-streaming helper: ask Claude for a short conversation title. Used by
 * POST /api/title to auto-name a chat after its first exchange.
 */
export async function generateTitle(
  firstUserMessage: string,
  firstAssistantMessage: string,
  options: StreamOptions = {},
): Promise<string> {
  const query = await getQuery();
  const cwd = await ensureClaudeCwd();
  const controller = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const prompt = [
    'Write a concise title (max 6 words, no quotes, no trailing punctuation) for this chat:',
    '',
    `User: ${firstUserMessage.slice(0, 500)}`,
    `Assistant: ${firstAssistantMessage.slice(0, 500)}`,
    '',
    'Reply with ONLY the title.',
  ].join('\n');

  let title = '';
  const consume = async (): Promise<void> => {
    for await (const message of query({
      prompt,
      options: {
        model: options.model || CLAUDE_MODEL,
        systemPrompt: 'You write short, descriptive chat titles. Reply with only the title.',
        allowedTools: [],
        maxTurns: 1,
        cwd,
        abortController: controller,
      },
    })) {
      if (message.type === 'result' && (message as any).subtype === 'success') {
        title = String((message as any).result ?? '').trim();
      }
    }
  };

  try {
    await withTimeout(consume(), 30_000, 'Claude title');
  } finally {
    controller.abort();
  }

  // Sanitize: strip quotes/newlines, clamp length.
  title = title.replace(/^["'\s]+|["'\s]+$/g, '').replace(/\s*\n.*$/s, '').trim();
  if (title.length > 60) title = title.slice(0, 60).trim();
  return title;
}
