// Streaming chat client. Uses expo/fetch (NOT the global fetch) because it exposes a
// readable response body on React Native, which is what lets us read the server's SSE
// stream chunk-by-chunk. The parsing loop mirrors TasteTrainer's web streamSSE.
import { fetch } from 'expo/fetch';

/** Server config + per-request options, passed in so runtime Settings overrides apply. */
export type ApiConfig = {
  serverUrl: string;
  appSharedSecret: string;
  model?: string;
  systemPrompt?: string;
  /** Parent-project context, appended to the system prompt server-side. */
  projectContext?: string;
  /** Extended thinking: ask the server for a reasoning budget before the answer. */
  thinking?: boolean;
};

/** A base64 attachment sent alongside a user turn. */
export type WireAttachment = {
  type: 'image' | 'document';
  mediaType: string;
  data: string;
};

export type WireMessage = {
  role: 'user' | 'assistant';
  content: string;
  attachments?: WireAttachment[];
};

export type Source = { url: string; title?: string };

export type StreamHandlers = {
  onDelta: (text: string) => void;
  onTool?: (info: { name: string; query?: string }) => void;
  onSources?: (sources: Source[]) => void;
  /** Called as soon as the first byte arrives (used to clear the "waking up" banner). */
  onOpen?: () => void;
};

function authHeaders(config: ApiConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-app-secret': config.appSharedSecret,
  };
}

/**
 * POST the conversation and consume the SSE reply, invoking handlers as events arrive.
 * Resolves when the stream completes; throws on a server error or non-OK response.
 * Pass `signal` to cancel an in-flight response (stop button).
 */
export async function streamChat(
  messages: WireMessage[],
  config: ApiConfig,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${config.serverUrl}/api/chat`, {
    method: 'POST',
    headers: authHeaders(config),
    body: JSON.stringify({
      messages,
      model: config.model || undefined,
      systemPrompt: config.systemPrompt || undefined,
      projectContext: config.projectContext || undefined,
      thinking: config.thinking || undefined,
    }),
    signal,
  });

  handlers.onOpen?.();

  // Pre-stream failures (validation, auth) come back as a normal JSON error, not SSE.
  if (!res.ok || !res.body) {
    let message = `Request failed (${res.status})`;
    try {
      const b = (await res.json()) as { error?: string };
      if (b?.error) message = b.error;
    } catch {
      /* non-JSON body — keep the status message */
    }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let errorMessage: string | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line; lines are `event:` and `data:`.
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let event = 'message';
        let data = '';
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        const parsed = JSON.parse(data) as {
          text?: string;
          error?: string;
          name?: string;
          query?: string;
          sources?: Source[];
        };
        if (event === 'delta') handlers.onDelta(parsed.text ?? '');
        else if (event === 'tool') handlers.onTool?.({ name: parsed.name ?? 'tool', query: parsed.query });
        else if (event === 'sources') handlers.onSources?.(parsed.sources ?? []);
        else if (event === 'error') errorMessage = parsed.error;
        // `done` needs no handling — the loop ends when the stream closes.
      }
    }
  } finally {
    // Releasing the reader cancels the underlying request if we bailed early (abort).
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }

  if (errorMessage) throw new Error(errorMessage);
}

/** Ask the server for a short auto-title. Best-effort: callers ignore failures. */
export async function fetchTitle(
  user: string,
  assistant: string,
  config: ApiConfig,
): Promise<string | null> {
  try {
    const res = await fetch(`${config.serverUrl}/api/title`, {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({ user, assistant, model: config.model || undefined }),
    });
    if (!res.ok) return null;
    const b = (await res.json()) as { title?: string };
    const t = (b.title ?? '').trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/** A model the account can use, from the live Anthropic model list. */
export type ModelOption = { id: string; label: string };

/** Fetch the available models from the server. Returns null if unreachable. */
export async function fetchModels(config: Pick<ApiConfig, 'serverUrl' | 'appSharedSecret'>): Promise<ModelOption[] | null> {
  try {
    const res = await fetch(`${config.serverUrl}/api/models`, {
      method: 'GET',
      headers: { 'x-app-secret': config.appSharedSecret },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { models?: ModelOption[] };
    return Array.isArray(body.models) && body.models.length > 0 ? body.models : null;
  } catch {
    return null;
  }
}

/** Liveness ping. Used to warm a sleeping host and to "Test connection" in Settings. */
export async function pingHealth(config: Pick<ApiConfig, 'serverUrl'>): Promise<boolean> {
  try {
    const res = await fetch(`${config.serverUrl}/api/health`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}
