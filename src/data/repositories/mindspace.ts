import { db } from '@/data/db';
import { newId } from '@/lib/id';
import type { Citation, Conversation, Message } from '@/domain/types';

export async function createConversation(bookId: string | null, title: string): Promise<Conversation> {
  const now = Date.now();
  const conversation: Conversation = {
    id: newId('conv'),
    bookId,
    title: title.trim() || 'New conversation',
    createdAt: now,
    updatedAt: now,
  };
  await db().run(
    'INSERT INTO conversations (id, book_id, title, created_at, updated_at) VALUES (?,?,?,?,?)',
    [conversation.id, conversation.bookId, conversation.title, now, now],
  );
  return conversation;
}

export async function listConversations(bookId?: string): Promise<
  (Conversation & { messageCount: number; lastMessage: string | null })[]
> {
  const rows = bookId
    ? await db().all<ConversationRow & { message_count: number; last_message: string | null }>(
        `SELECT c.*, COUNT(m.id) as message_count,
                (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message
         FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id
         WHERE c.book_id = ? GROUP BY c.id ORDER BY c.updated_at DESC`,
        [bookId],
      )
    : await db().all<ConversationRow & { message_count: number; last_message: string | null }>(
        `SELECT c.*, COUNT(m.id) as message_count,
                (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message
         FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id
         GROUP BY c.id ORDER BY c.updated_at DESC`,
      );
  return rows.map((r) => ({
    id: r.id,
    bookId: r.book_id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: r.message_count ?? 0,
    lastMessage: r.last_message,
  }));
}

type ConversationRow = {
  id: string;
  book_id: string | null;
  title: string;
  created_at: number;
  updated_at: number;
};

export async function getConversation(id: string): Promise<Conversation | null> {
  const r = await db().first<ConversationRow>('SELECT * FROM conversations WHERE id = ?', [id]);
  if (!r) return null;
  return {
    id: r.id,
    bookId: r.book_id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function addMessage(
  conversationId: string,
  role: Message['role'],
  content: string,
  citations?: Citation[] | null,
): Promise<Message> {
  const message: Message = {
    id: newId('msg'),
    conversationId,
    role,
    content,
    citations: citations ?? null,
    createdAt: Date.now(),
  };
  await db().transaction(async () => {
    await db().run(
      'INSERT INTO messages (id, conversation_id, role, content, citations_json, created_at) VALUES (?,?,?,?,?,?)',
      [
        message.id,
        message.conversationId,
        message.role,
        message.content,
        citations ? JSON.stringify(citations) : null,
        message.createdAt,
      ],
    );
    await db().run('UPDATE conversations SET updated_at = ? WHERE id = ?', [message.createdAt, conversationId]);
  });
  return message;
}

export async function listMessages(conversationId: string): Promise<Message[]> {
  const rows = await db().all<{
    id: string;
    conversation_id: string;
    role: string;
    content: string;
    citations_json: string | null;
    created_at: number;
  }>('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC', [conversationId]);
  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role as Message['role'],
    content: r.content,
    citations: r.citations_json ? (JSON.parse(r.citations_json) as Citation[]) : null,
    createdAt: r.created_at,
  }));
}

export async function deleteConversation(id: string): Promise<void> {
  await db().run('DELETE FROM conversations WHERE id = ?', [id]);
}

export async function renameConversation(id: string, title: string): Promise<void> {
  await db().run('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?', [
    title.trim() || 'Conversation',
    Date.now(),
    id,
  ]);
}

export async function conversationCount(): Promise<number> {
  const row = await db().first<{ count: number }>('SELECT COUNT(*) as count FROM conversations');
  return row?.count ?? 0;
}
