import path from 'node:path';
import { DATA_DIR } from './utils.js';
import { atomicRead, atomicWrite, withFileLock } from './utils.js';
import { randomUUID } from 'node:crypto';
import type { ChatHistory, ChatMessage } from './types.js';

const CHAT_PATH = path.join(DATA_DIR, 'chat_history.json');

export async function getChatHistories(): Promise<ChatHistory[]> {
  return atomicRead(CHAT_PATH, []);
}

export async function saveChatHistory(title: string): Promise<ChatHistory> {
  // P1-2: withFileLock
  return withFileLock(CHAT_PATH, async () => {
    const histories = await getChatHistories();
    const now = new Date().toISOString();
    const item: ChatHistory = {
      id: randomUUID(),
      title,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    histories.push(item);
    await atomicWrite(CHAT_PATH, histories);
    return item;
  });
}

export async function addChatMessage(chatId: string, message: { role: ChatMessage['role']; content: string }): Promise<ChatMessage | null> {
  return withFileLock(CHAT_PATH, async () => {
    const histories = await getChatHistories();
    const chat = histories.find(h => h.id === chatId);
    if (!chat) return null;
    const msg: ChatMessage = { ...message, id: randomUUID(), timestamp: new Date().toISOString() };
    chat.messages.push(msg);
    chat.updatedAt = new Date().toISOString();
    await atomicWrite(CHAT_PATH, histories);
    return msg;
  });
}

export async function deleteChatHistory(id: string): Promise<boolean> {
  return withFileLock(CHAT_PATH, async () => {
    const histories = await getChatHistories();
    const filtered = histories.filter(h => h.id !== id);
    if (filtered.length === histories.length) return false;
    await atomicWrite(CHAT_PATH, filtered);
    return true;
  });
}