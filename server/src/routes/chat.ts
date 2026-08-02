import { Router } from 'express';
import type { Response } from 'express';
import { streamChat, type ChatMessage } from '../services/claude.ts';

// The chat reply streams in over many seconds, so the endpoint emits Server-Sent
// Events: `delta` chunks (append each to the assistant bubble), `tool` (web search/fetch
// started), `sources` (links found), then a single `done`, or an `error`. The app reads
// this with expo/fetch + a stream reader (see app/src/api.ts).
type SseEvent = 'delta' | 'tool' | 'sources' | 'done' | 'error';
function sse(res: Response) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // No proxy buffering — each chunk must reach the device as it's written.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  return (event: SseEvent, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

export const chatRouter = Router();

// POST /api/chat
//   body: { messages: [{ role, content, attachments? }], model?, systemPrompt? }
//   streams: delta {text} | tool {name,query} | sources {sources} ... then done {}
//            (or error {error}).
chatRouter.post('/', async (req, res) => {
  const { messages, model, systemPrompt, projectContext, thinking } = req.body as {
    messages?: ChatMessage[];
    model?: string;
    systemPrompt?: string;
    projectContext?: string;
    thinking?: boolean;
  };
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  // When the phone hangs up (stop button, app backgrounded, network drop), abort the
  // Claude subprocess promptly instead of letting it run to completion unseen. NOTE: use
  // `res` 'close', not `req` 'close' — the latter fires as soon as the request body is
  // consumed (not on disconnect), which would abort every call instantly. Guard with
  // writableEnded so a normal finish doesn't look like a disconnect.
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  const send = sse(res);
  try {
    await streamChat(
      messages,
      {
        onDelta: (text) => send('delta', { text }),
        onTool: (info) => send('tool', info),
        onSources: (sources) => send('sources', { sources }),
      },
      { model, systemPrompt, projectContext, thinking: thinking === true, signal: controller.signal },
    );
    send('done', {});
  } catch (err: any) {
    // A client-initiated abort isn't a real error — don't spam the stream or the logs.
    if (!controller.signal.aborted) {
      console.error('[chat] error:', err?.message ?? err);
      send('error', { error: err?.message ?? 'Chat failed' });
    }
  }
  res.end();
});
