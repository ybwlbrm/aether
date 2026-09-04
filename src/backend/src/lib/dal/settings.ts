import path from 'node:path';
import { DATA_DIR } from './utils.js';
import { atomicRead, atomicWrite, withFileLock } from './utils.js';
import type { SettingsData } from './types.js';

const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
import { DEFAULT_SETTINGS } from './types.js';

export async function getSettings(): Promise<SettingsData> {
  return atomicRead(SETTINGS_PATH, DEFAULT_SETTINGS);
}

export async function saveSettings(data: Partial<SettingsData>): Promise<SettingsData> {
  // P2-2: per-file mutex 防并发 read-modify-write 丢失更新
  return withFileLock(SETTINGS_PATH, async () => {
    const current = await getSettings();
    const updated: SettingsData = { ...current, ...data, updatedAt: new Date().toISOString() };
    await atomicWrite(SETTINGS_PATH, updated);
    return updated;
  });
}