// SQLite persistence for conversations + messages. Per-message inserts (cheap on an
// old phone) instead of rewriting one big JSON blob. Attachments/sources are stored as
// JSON columns — fine at single-user scale. See plan: storage section.
import * as SQLite from 'expo-sqlite';
import { newId } from './id';
import { deleteAttachment } from './attachments';
import type { Attachment, Conversation, Message, Project, Role, Source } from './types';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync('claude7.db').then(async (db) => {
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY NOT NULL,
          title TEXT NOT NULL,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL,
          model TEXT,
          systemPrompt TEXT
        );
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY NOT NULL,
          conversationId TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          createdAt INTEGER NOT NULL,
          attachments TEXT,
          sources TEXT,
          status TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations (updatedAt DESC);
        CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages (conversationId, createdAt ASC);
      `);
      await migrate(db);
      return db;
    });
  }
  return dbPromise;
}

/**
 * Versioned migrations layered on top of the idempotent CREATE TABLEs above. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so PRAGMA user_version gates each step to run exactly once,
 * protecting existing installs' data.
 *   v1 — Projects: a `projects` table + a nullable `projectId` FK column on conversations.
 */
async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const version = row?.user_version ?? 0;
  if (version < 1) {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        goal TEXT,
        contextPrompt TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      ALTER TABLE conversations ADD COLUMN projectId TEXT;
      CREATE INDEX IF NOT EXISTS idx_conv_project ON conversations (projectId);
      PRAGMA user_version = 1;
    `);
  }
}

/** Call once at app start (App.tsx) so the schema exists before any screen reads it. */
export async function initDb(): Promise<void> {
  await getDb();
}

// ---- Conversations ---------------------------------------------------------

export async function listConversations(): Promise<Conversation[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Conversation>(
    'SELECT * FROM conversations ORDER BY updatedAt DESC',
  );
  return rows;
}

export type ConversationSearchHit = { conversation: Conversation; snippet?: string };

/**
 * Search saved chats by title and by message text. Returns matching conversations
 * (newest first), each with a short snippet of the first matching message when the hit
 * came from message content. Single-user scale, so a couple of LIKE queries are plenty.
 */
export async function searchConversations(query: string): Promise<ConversationSearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const db = await getDb();
  // Escape LIKE wildcards so a literal % or _ in the query matches itself.
  const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const rows = await db.getAllAsync<Conversation & { matchContent: string | null }>(
    `SELECT c.*, (
        SELECT m.content FROM messages m
        WHERE m.conversationId = c.id AND m.content LIKE ? ESCAPE '\\'
        ORDER BY m.createdAt ASC LIMIT 1
      ) AS matchContent
      FROM conversations c
      WHERE c.title LIKE ? ESCAPE '\\'
         OR EXISTS (
           SELECT 1 FROM messages m2
           WHERE m2.conversationId = c.id AND m2.content LIKE ? ESCAPE '\\'
         )
      ORDER BY c.updatedAt DESC`,
    like,
    like,
    like,
  );
  return rows.map(({ matchContent, ...conversation }) => ({
    conversation,
    snippet: matchContent ? buildSnippet(matchContent, q) : undefined,
  }));
}

/** A ~120-char window of `content` centered on the first case-insensitive match of `q`. */
function buildSnippet(content: string, q: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  const idx = flat.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return flat.slice(0, 120);
  const start = Math.max(0, idx - 40);
  const end = Math.min(flat.length, idx + q.length + 80);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

export async function getConversation(id: string): Promise<Conversation | null> {
  const db = await getDb();
  return (
    (await db.getFirstAsync<Conversation>('SELECT * FROM conversations WHERE id = ?', id)) ?? null
  );
}

export async function createConversation(
  seed: Partial<Pick<Conversation, 'title' | 'model' | 'systemPrompt' | 'projectId'>> = {},
): Promise<Conversation> {
  const db = await getDb();
  const now = Date.now();
  const conv: Conversation = {
    id: newId('conv'),
    title: seed.title ?? 'New chat',
    createdAt: now,
    updatedAt: now,
    model: seed.model,
    systemPrompt: seed.systemPrompt,
    projectId: seed.projectId,
  };
  await db.runAsync(
    'INSERT INTO conversations (id, title, createdAt, updatedAt, model, systemPrompt, projectId) VALUES (?, ?, ?, ?, ?, ?, ?)',
    conv.id,
    conv.title,
    conv.createdAt,
    conv.updatedAt,
    conv.model ?? null,
    conv.systemPrompt ?? null,
    conv.projectId ?? null,
  );
  return conv;
}

/** Conversations belonging to a project, newest first. */
export async function listConversationsByProject(projectId: string): Promise<Conversation[]> {
  const db = await getDb();
  return db.getAllAsync<Conversation>(
    'SELECT * FROM conversations WHERE projectId = ? ORDER BY updatedAt DESC',
    projectId,
  );
}

/** Set a per-chat model override (null clears it back to the global default). */
export async function updateConversationModel(id: string, model: string | null): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE conversations SET model = ? WHERE id = ?', model, id);
}

export async function renameConversation(id: string, title: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE conversations SET title = ? WHERE id = ?', title, id);
}

export async function touchConversation(id: string, when = Date.now()): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE conversations SET updatedAt = ? WHERE id = ?', when, id);
}

export async function deleteConversation(id: string): Promise<void> {
  const db = await getDb();
  // Clean up attachment files on disk before dropping the rows.
  const msgs = await getMessages(id);
  for (const m of msgs) {
    for (const a of m.attachments ?? []) {
      await deleteAttachment(a.uri).catch(() => {});
    }
  }
  await db.runAsync('DELETE FROM messages WHERE conversationId = ?', id);
  await db.runAsync('DELETE FROM conversations WHERE id = ?', id);
}

// ---- Projects --------------------------------------------------------------

export async function listProjects(): Promise<Project[]> {
  const db = await getDb();
  return db.getAllAsync<Project>('SELECT * FROM projects ORDER BY updatedAt DESC');
}

export async function getProject(id: string): Promise<Project | null> {
  const db = await getDb();
  return (await db.getFirstAsync<Project>('SELECT * FROM projects WHERE id = ?', id)) ?? null;
}

export async function createProject(
  seed: Partial<Pick<Project, 'title' | 'goal' | 'contextPrompt'>> = {},
): Promise<Project> {
  const db = await getDb();
  const now = Date.now();
  const project: Project = {
    id: newId('proj'),
    title: seed.title?.trim() || 'New project',
    goal: seed.goal,
    contextPrompt: seed.contextPrompt,
    createdAt: now,
    updatedAt: now,
  };
  await db.runAsync(
    'INSERT INTO projects (id, title, goal, contextPrompt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
    project.id,
    project.title,
    project.goal ?? null,
    project.contextPrompt ?? null,
    project.createdAt,
    project.updatedAt,
  );
  return project;
}

export async function updateProject(
  id: string,
  patch: Partial<Pick<Project, 'title' | 'goal' | 'contextPrompt'>>,
): Promise<void> {
  const db = await getDb();
  const sets: string[] = [];
  const args: SQLite.SQLiteBindValue[] = [];
  if (patch.title !== undefined) {
    sets.push('title = ?');
    args.push(patch.title);
  }
  if (patch.goal !== undefined) {
    sets.push('goal = ?');
    args.push(patch.goal || null);
  }
  if (patch.contextPrompt !== undefined) {
    sets.push('contextPrompt = ?');
    args.push(patch.contextPrompt || null);
  }
  sets.push('updatedAt = ?');
  args.push(Date.now());
  args.push(id);
  await db.runAsync(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`, ...args);
}

/** Delete a project. Its chats are kept but detached (projectId → NULL), never destroyed. */
export async function deleteProject(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE conversations SET projectId = NULL WHERE projectId = ?', id);
  await db.runAsync('DELETE FROM projects WHERE id = ?', id);
}

// ---- Messages --------------------------------------------------------------

type MessageRow = {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  createdAt: number;
  attachments: string | null;
  sources: string | null;
  status: Message['status'] | null;
};

function parseJson<T>(raw: string | null): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function rowToMessage(r: MessageRow): Message {
  return {
    id: r.id,
    conversationId: r.conversationId,
    role: r.role,
    content: r.content,
    createdAt: r.createdAt,
    attachments: parseJson<Attachment[]>(r.attachments),
    sources: parseJson<Source[]>(r.sources),
    status: r.status ?? undefined,
  };
}

export async function getMessages(conversationId: string): Promise<Message[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<MessageRow>(
    'SELECT * FROM messages WHERE conversationId = ? ORDER BY createdAt ASC',
    conversationId,
  );
  return rows.map(rowToMessage);
}

export async function appendMessage(
  msg: Omit<Message, 'id' | 'createdAt'> & { id?: string; createdAt?: number },
): Promise<Message> {
  const db = await getDb();
  const full: Message = {
    ...msg,
    id: msg.id ?? newId('msg'),
    createdAt: msg.createdAt ?? Date.now(),
  };
  await db.runAsync(
    'INSERT INTO messages (id, conversationId, role, content, createdAt, attachments, sources, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    full.id,
    full.conversationId,
    full.role,
    full.content,
    full.createdAt,
    full.attachments ? JSON.stringify(full.attachments) : null,
    full.sources ? JSON.stringify(full.sources) : null,
    full.status ?? null,
  );
  await touchConversation(full.conversationId, full.createdAt);
  return full;
}

export async function updateMessage(
  id: string,
  patch: Partial<Pick<Message, 'content' | 'sources' | 'status' | 'attachments'>>,
): Promise<void> {
  const db = await getDb();
  const sets: string[] = [];
  const args: SQLite.SQLiteBindValue[] = [];
  if (patch.content !== undefined) {
    sets.push('content = ?');
    args.push(patch.content);
  }
  if (patch.sources !== undefined) {
    sets.push('sources = ?');
    args.push(patch.sources ? JSON.stringify(patch.sources) : null);
  }
  if (patch.attachments !== undefined) {
    sets.push('attachments = ?');
    args.push(patch.attachments ? JSON.stringify(patch.attachments) : null);
  }
  if (patch.status !== undefined) {
    sets.push('status = ?');
    args.push(patch.status ?? null);
  }
  if (sets.length === 0) return;
  args.push(id);
  await db.runAsync(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`, ...args);
}

export async function deleteMessage(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM messages WHERE id = ?', id);
}

/** Delete a message and every message after it in the same chat (used by regenerate). */
export async function deleteMessagesFrom(conversationId: string, createdAt: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'DELETE FROM messages WHERE conversationId = ? AND createdAt >= ?',
    conversationId,
    createdAt,
  );
}
