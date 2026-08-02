// Core chat engine for a single conversation: load history, send (with attachments),
// stream the reply, stop mid-flight, regenerate, edit-and-resend. Persists to SQLite
// during streaming at a throttled cadence (the UI re-renders at most ~4 fps while tokens
// arrive — cheap enough for live Markdown on an iPhone 7). Surfaces "waking up" and
// "searching the web" states for the UI.
//
// Two behaviours beyond the original engine:
//  - Lazy conversation creation: mounted with no conversationId, the hook is an empty
//    "new chat"; the SQLite row is created on the first send and reported via
//    onConversationCreated so the screen can pin the id into its route params.
//  - Ephemeral (incognito) mode: nothing ever touches SQLite; the transcript lives only
//    in memory and attachment files are deleted when the session ends.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchTitle,
  streamChat,
  type ApiConfig,
  type Source,
  type WireAttachment,
  type WireMessage,
} from '../api';
import {
  appendMessage,
  createConversation,
  deleteMessagesFrom,
  getMessages,
  renameConversation,
  touchConversation,
  updateMessage,
} from '../storage/db';
import { deleteAttachment, toBase64 } from '../storage/attachments';
import type { Attachment, Conversation, Message } from '../storage/types';
import { newId } from '../storage/id';

const WAKE_DELAY_MS = 3000;
// Flush streamed text to state at most this often. Each flush re-renders the streaming
// bubble's Markdown; ~4 fps reads as live while staying comfortable on an iPhone 7.
const STREAM_FLUSH_MS = 250;
// Cap the total base64 attachment payload across the WHOLE request. The server is
// stateless, so we resend every turn's image/document bytes each time (that's what keeps
// past images in context). A long, image-heavy chat could otherwise blow the server's
// 15 MB body limit and 413; we keep the newest attachments within this budget and drop
// older ones with a note. base64 inflates ~33%, so 12 MB of base64 leaves headroom.
const MAX_WIRE_BASE64 = 12 * 1024 * 1024;

// A transient user turn appended to the wire (only) when resuming a stopped reply, so the
// model continues its previous answer. Never persisted or shown.
const CONTINUE_TURN: WireMessage = {
  role: 'user',
  content:
    'Continue your previous response from exactly where it stopped. Do not repeat or restate anything you already wrote — just keep going seamlessly.',
};

type SendArgs = { text: string; attachments?: Attachment[] };

export type UseChatOptions = {
  /** Incognito: keep the whole session in memory, never write to SQLite. */
  ephemeral?: boolean;
  /** Fired when a lazily-created conversation gets its SQLite row (first send). */
  onConversationCreated?: (conv: Conversation) => void;
};

/**
 * @param chatKey identity of the chat session. Changing it resets the hook (aborting any
 *   stream and cleaning up an ephemeral session) — EXCEPT when the change is the route
 *   catching up to a conversation this hook just lazily created.
 * @param conversationId the persisted conversation, or undefined for a new/incognito chat.
 */
export function useChat(
  chatKey: string,
  conversationId: string | undefined,
  config: ApiConfig,
  onTitle?: (title: string) => void,
  options?: UseChatOptions,
) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waking, setWaking] = useState(false);
  const [searching, setSearching] = useState<{ name: string; query?: string } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const wakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest values behind stable refs so every callback below can have an empty dep list —
  // a streaming flush must not recreate callbacks (that would bust MessageBubble's memo
  // for every bubble on every flush).
  const configRef = useRef(config);
  configRef.current = config;
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const messagesRef = useRef<Message[]>([]);
  const busyRef = useRef(false);
  // The conversation whose transcript is loaded; set lazily on first send for new chats.
  const convIdRef = useRef<string | null>(conversationId ?? null);
  const ephemeralRef = useRef(!!options?.ephemeral);

  const commit = useCallback((next: Message[]) => {
    messagesRef.current = next;
    setMessages(next);
  }, []);

  /** Delete the attachment files an incognito transcript references (they never persist). */
  const cleanupEphemeral = (msgs: Message[]) => {
    for (const m of msgs) {
      for (const a of m.attachments ?? []) {
        void deleteAttachment(a.uri).catch(() => {});
      }
    }
  };

  // Reset/load when the chat session changes. Skips the no-op case where the route params
  // catch up to a conversation we just created lazily (same id — state is already live).
  useEffect(() => {
    if (conversationId && conversationId === convIdRef.current) return;

    abortRef.current?.abort();
    if (ephemeralRef.current && messagesRef.current.length > 0) {
      cleanupEphemeral(messagesRef.current);
    }
    ephemeralRef.current = !!optionsRef.current?.ephemeral;
    convIdRef.current = conversationId ?? null;
    commit([]);
    setError(null);
    setBusy(false);
    busyRef.current = false;

    if (conversationId && !ephemeralRef.current) {
      let alive = true;
      getMessages(conversationId).then((m) => {
        // Guard against a session switch racing the load.
        if (alive && convIdRef.current === conversationId) commit(m);
      });
      return () => {
        alive = false;
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatKey]);

  // On unmount: abort any stream and clean up an incognito session's files.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (ephemeralRef.current) cleanupEphemeral(messagesRef.current);
    },
    [],
  );

  const clearWakeTimer = () => {
    if (wakeTimerRef.current) {
      clearTimeout(wakeTimerRef.current);
      wakeTimerRef.current = null;
    }
  };

  /** The active conversation id, creating the SQLite row lazily on first use. */
  const ensureConversation = useCallback(async (): Promise<string> => {
    if (convIdRef.current) return convIdRef.current;
    if (ephemeralRef.current) {
      convIdRef.current = newId('incog');
      return convIdRef.current;
    }
    const conv = await createConversation();
    convIdRef.current = conv.id;
    optionsRef.current?.onConversationCreated?.(conv);
    return conv.id;
  }, []);

  // Turn on-disk attachments into base64 wire form at send time (never persisted). The full
  // history — including every past turn's attachments — is resent so the model keeps earlier
  // images/files in context. To stay under the server body limit, walk newest-first and keep
  // attachments within MAX_WIRE_BASE64; any older ones beyond the budget are dropped with a
  // short note in that turn's text.
  const toWire = useCallback(async (history: Message[]): Promise<WireMessage[]> => {
    const encoded = await Promise.all(
      history.map(async (m) => {
        const atts: WireAttachment[] = [];
        for (const a of m.attachments ?? []) {
          try {
            atts.push({ type: a.type, mediaType: a.mediaType, data: await toBase64(a.uri) });
          } catch {
            /* skip an unreadable file rather than failing the whole turn */
          }
        }
        return { role: m.role, content: m.content, atts };
      }),
    );

    const out: WireMessage[] = encoded.map((e) => ({ role: e.role, content: e.content }));
    let used = 0;
    for (let i = encoded.length - 1; i >= 0; i--) {
      const { atts } = encoded[i];
      if (atts.length === 0) continue;
      const kept: WireAttachment[] = [];
      let droppedHere = 0;
      for (const a of atts) {
        if (used + a.data.length <= MAX_WIRE_BASE64) {
          used += a.data.length;
          kept.push(a);
        } else {
          droppedHere++;
        }
      }
      if (kept.length > 0) out[i].attachments = kept;
      if (droppedHere > 0) {
        const note = `(${droppedHere} earlier attachment${droppedHere > 1 ? 's' : ''} omitted to stay within the size limit)`;
        out[i].content = out[i].content ? `${out[i].content}\n\n${note}` : note;
        console.warn(`[chat] dropped ${droppedHere} attachment(s) from an earlier turn to fit the wire budget.`);
      }
    }
    return out;
  }, []);

  /**
   * Run a streamed assistant turn.
   *  - `mode: 'new'` (default): append a fresh assistant turn over `history` (which already
   *    ends at the user turn). On Stop with partial text, the turn is saved as 'stopped'.
   *  - `mode: 'continue'`: resume the existing (stopped) `target` message in place — seed the
   *    stream with its current content/sources, send the history followed by a transient
   *    "keep going" user turn (never persisted/visible), append new deltas into the SAME
   *    bubble, and UPDATE the row on completion. No auto-title.
   */
  const runAssistant = useCallback(
    async (history: Message[], isFirstExchange: boolean, resume?: { target: Message }) => {
      const convId = convIdRef.current;
      if (!convId) return;
      const ephemeral = ephemeralRef.current;

      setBusy(true);
      busyRef.current = true;
      setError(null);
      setSearching(null);

      const resuming = !!resume;
      const assistantLocalId = resume ? resume.target.id : newId('msg');

      if (resume) {
        // Keep the stopped bubble; flip it back to streaming and continue filling it.
        commit(
          messagesRef.current.map((m) =>
            m.id === assistantLocalId ? { ...m, status: 'streaming' as const } : m,
          ),
        );
      } else {
        const placeholder: Message = {
          id: assistantLocalId,
          conversationId: convId,
          role: 'assistant',
          content: '',
          createdAt: Date.now(),
          status: 'streaming',
        };
        commit([...history, placeholder]);
      }

      const controller = new AbortController();
      abortRef.current = controller;

      // Only show "waking up…" if the (possibly sleeping) server is slow to respond —
      // not on every message. Cleared as soon as the first byte arrives (onOpen).
      wakeTimerRef.current = setTimeout(() => setWaking(true), WAKE_DELAY_MS);

      let collected = resume ? resume.target.content : '';
      // Seed from the stopped turn's sources so a continuation merges with them, not replaces.
      const collectedSources: Source[] = resume?.target.sources ? [...resume.target.sources] : [];

      const patchAssistant = (patch: Partial<Message>) => {
        const next = messagesRef.current.slice();
        const i = next.findIndex((m) => m.id === assistantLocalId);
        if (i >= 0) {
          next[i] = { ...next[i], ...patch };
          commit(next);
        }
      };

      // Throttle streamed-text flushes: deltas accumulate in `collected` and reach state at
      // most every STREAM_FLUSH_MS. Each flush re-renders one Markdown bubble; everything
      // else is memoized. This is what makes live Markdown viable on the iPhone 7.
      let dirty = false;
      const flush = () => {
        if (!dirty) return;
        dirty = false;
        patchAssistant({ content: collected });
      };
      const flushTimer = setInterval(flush, STREAM_FLUSH_MS);

      // Persist: a new turn INSERTs; a continued turn UPDATEs the existing row.
      const persist = async (status: Message['status']) => {
        if (ephemeral) return;
        const sources = collectedSources.length ? collectedSources : undefined;
        if (resuming) {
          await updateMessage(assistantLocalId, { content: collected, sources, status });
          await touchConversation(convId);
        } else {
          await appendMessage({
            id: assistantLocalId,
            conversationId: convId,
            role: 'assistant',
            content: collected,
            sources,
            status,
          });
        }
      };

      try {
        const baseWire = await toWire(history);
        const wire = resume ? [...baseWire, CONTINUE_TURN] : baseWire;
        await streamChat(
          wire,
          configRef.current,
          {
            onOpen: () => {
              clearWakeTimer();
              setWaking(false);
            },
            onDelta: (text) => {
              collected += text;
              dirty = true;
            },
            onTool: (info) => setSearching(info),
            onSources: (sources) => {
              // Union by URL so a continuation keeps the stopped turn's earlier sources.
              const byUrl = new Map(collectedSources.map((s) => [s.url, s]));
              for (const s of sources) if (!byUrl.has(s.url)) byUrl.set(s.url, s);
              const merged = [...byUrl.values()];
              collectedSources.splice(0, collectedSources.length, ...merged);
              patchAssistant({ sources: [...merged] });
            },
          },
          controller.signal,
        );

        // Success — flush the tail, persist the finished assistant turn once.
        flush();
        patchAssistant({ status: 'complete' });
        await persist('complete');

        // Auto-title after the first real exchange (never on a continuation). Incognito
        // chats still get a local header title but no SQLite rename.
        if (!resuming && isFirstExchange && collected.trim().length > 0) {
          const firstUser = history.find((m) => m.role === 'user');
          if (firstUser) {
            const title = await fetchTitle(firstUser.content, collected, configRef.current);
            if (title) {
              if (!ephemeral) await renameConversation(convId, title);
              onTitleRef.current?.(title);
            }
          }
        }
      } catch (e: any) {
        flush();
        const aborted = controller.signal.aborted;
        if (collected.trim().length > 0) {
          // A user Stop becomes 'stopped' (offers Retry/Continue); a dropped connection
          // mid-answer commits what streamed as 'complete'.
          const status: Message['status'] = aborted ? 'stopped' : 'complete';
          patchAssistant({ status });
          await persist(status);
        } else if (resuming) {
          // Nothing new streamed on a continue — leave the stopped turn as it was.
          patchAssistant({ status: 'stopped' });
        } else {
          // Nothing streamed at all — drop the placeholder.
          commit(messagesRef.current.filter((m) => m.id !== assistantLocalId));
        }
        if (!aborted) setError(e?.message ?? 'Something went wrong.');
      } finally {
        clearInterval(flushTimer);
        clearWakeTimer();
        setWaking(false);
        setSearching(null);
        setBusy(false);
        busyRef.current = false;
        abortRef.current = null;
      }
    },
    [commit, toWire],
  );

  const send = useCallback(
    async ({ text, attachments }: SendArgs) => {
      const trimmed = text.trim();
      if ((!trimmed && !(attachments && attachments.length)) || busyRef.current) return;

      const convId = await ensureConversation();
      const atts = attachments && attachments.length ? attachments : undefined;
      const userMsg: Message = ephemeralRef.current
        ? {
            id: newId('msg'),
            conversationId: convId,
            role: 'user',
            content: trimmed,
            createdAt: Date.now(),
            attachments: atts,
            status: 'complete',
          }
        : await appendMessage({
            conversationId: convId,
            role: 'user',
            content: trimmed,
            attachments: atts,
            status: 'complete',
          });

      const prior = messagesRef.current;
      const isFirstExchange = prior.length === 0;
      const history = [...prior, userMsg];
      commit(history);
      await runAssistant(history, isFirstExchange);
    },
    [commit, ensureConversation, runAssistant],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /** Re-run the most recent assistant turn (drops it and re-sends the prior user turn). */
  const regenerate = useCallback(async () => {
    if (busyRef.current) return;
    const msgs = messagesRef.current;
    let lastAssistantIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'assistant') {
        lastAssistantIdx = i;
        break;
      }
    }
    if (lastAssistantIdx <= 0) return;
    const assistant = msgs[lastAssistantIdx];
    // Truncate persisted + in-memory history back to (but excluding) that assistant turn.
    if (!ephemeralRef.current && convIdRef.current) {
      await deleteMessagesFrom(convIdRef.current, assistant.createdAt);
    }
    const history = msgs.slice(0, lastAssistantIdx);
    commit(history);
    await runAssistant(history, history.length === 1);
  }, [commit, runAssistant]);

  /** Resume a stopped reply in place (keeps the partial text, continues the same bubble). */
  const continueReply = useCallback(async () => {
    if (busyRef.current) return;
    const msgs = messagesRef.current;
    let lastAssistantIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'assistant') {
        lastAssistantIdx = i;
        break;
      }
    }
    if (lastAssistantIdx < 0) return;
    const target = msgs[lastAssistantIdx];
    if (target.status !== 'stopped') return;
    // History through and including the stopped turn; the wire adds CONTINUE_TURN.
    const history = msgs.slice(0, lastAssistantIdx + 1);
    await runAssistant(history, false, { target });
  }, [runAssistant]);

  /**
   * Replace a sent user message with new text and regenerate from that point. Everything
   * after the edited message is discarded (truncate, not branch). The original message's
   * attachments carry over — their files are still on disk.
   */
  const editAndResend = useCallback(
    async (messageId: string, newText: string) => {
      const trimmed = newText.trim();
      if (!trimmed || busyRef.current) return;
      const msgs = messagesRef.current;
      const idx = msgs.findIndex((m) => m.id === messageId);
      if (idx < 0 || msgs[idx].role !== 'user') return;
      const original = msgs[idx];
      const convId = convIdRef.current;
      if (!convId) return;

      if (!ephemeralRef.current) {
        await deleteMessagesFrom(convId, original.createdAt);
      }
      const userMsg: Message = ephemeralRef.current
        ? {
            id: newId('msg'),
            conversationId: convId,
            role: 'user',
            content: trimmed,
            createdAt: Date.now(),
            attachments: original.attachments,
            status: 'complete',
          }
        : await appendMessage({
            conversationId: convId,
            role: 'user',
            content: trimmed,
            attachments: original.attachments,
            status: 'complete',
          });

      const history = [...msgs.slice(0, idx), userMsg];
      commit(history);
      await runAssistant(history, history.length === 1);
    },
    [commit, runAssistant],
  );

  return {
    messages,
    busy,
    error,
    waking,
    searching,
    send,
    stop,
    regenerate,
    continueReply,
    editAndResend,
    setError,
  };
}
