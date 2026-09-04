import path from 'node:path';
import { DATA_DIR } from './utils.js';
import { atomicRead, atomicWrite, withFileLock } from './utils.js';
import { randomUUID } from 'node:crypto';
import type { ProjectItem } from './types.js';

const PROJECTS_PATH = path.join(DATA_DIR, 'projects.json');

export async function getProjects(): Promise<ProjectItem[]> {
  return atomicRead(PROJECTS_PATH, []);
}

export async function saveProject(data: { name: string; type: 'url' | 'bat' | 'command'; target: string; category?: string; description?: string }): Promise<ProjectItem> {
  // P1-2: withFileLock 防并发 read-modify-write 丢失更新
  return withFileLock(PROJECTS_PATH, async () => {
    const projects = await getProjects();
    const now = new Date().toISOString();
    const item: ProjectItem = {
      id: randomUUID(),
      name: data.name,
      type: data.type,
      target: data.target,
      category: data.category,
      description: data.description,
      createdAt: now,
    };
    projects.push(item);
    await atomicWrite(PROJECTS_PATH, projects);
    return item;
  });
}

export async function updateProject(id: string, data: Partial<ProjectItem>): Promise<ProjectItem | null> {
  return withFileLock(PROJECTS_PATH, async () => {
    const projects = await getProjects();
    const idx = projects.findIndex(p => p.id === id);
    if (idx === -1) return null;
    projects[idx] = { ...projects[idx], ...data, id };
    await atomicWrite(PROJECTS_PATH, projects);
    return projects[idx];
  });
}

export async function deleteProject(id: string): Promise<boolean> {
  return withFileLock(PROJECTS_PATH, async () => {
    const projects = await getProjects();
    const filtered = projects.filter(p => p.id !== id);
    if (filtered.length === projects.length) return false;
    await atomicWrite(PROJECTS_PATH, filtered);
    return true;
  });
}