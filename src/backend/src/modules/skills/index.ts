import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { readdirSync, readFileSync, existsSync, rmSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { homedir } from 'node:os';

/** 技能状态存储路径 */
function getSkillsStatePath(config: BackendConfig): string {
  return resolve(config.dataDir, 'skills-state.json');
}

/** 读取技能启用/禁用状态 */
function loadSkillsState(config: BackendConfig): Record<string, boolean> {
  const statePath = getSkillsStatePath(config);
  try {
    if (existsSync(statePath)) {
      return JSON.parse(readFileSync(statePath, 'utf-8'));
    }
  } catch { /* 忽略 */ }
  return {};
}

/** 保存技能启用/禁用状态 */
function saveSkillsState(config: BackendConfig, state: Record<string, boolean>): void {
  writeFileSync(getSkillsStatePath(config), JSON.stringify(state, null, 2), 'utf-8');
}

export function registerSkillsRoutes(app: FastifyInstance, config: BackendConfig): void {

  // 扫描所有可用的技能
  app.get('/api/skills', {
    schema: { description: '获取所有可用技能', tags: ['技能'] },
  }, async () => {
    // 扫描多个技能目录（全局配置 + 项目目录）
    const searchPaths = [
      resolve(homedir(), '.config', 'opencode', 'skills'),
      resolve(homedir(), '.codex', 'skills'),
      resolve(process.cwd(), 'skills'),       // 项目内导入的技能
      resolve(process.cwd(), '.opencode', 'skills'),
      resolve(process.cwd(), '.codex', 'skills'),
    ];

    const skills: any[] = [];
    const seen = new Set<string>();
    const state = loadSkillsState(config);

    for (const dir of searchPaths) {
      if (!existsSync(dir)) continue;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const skillDir = resolve(dir, entry.name);
          const skillMdPath = resolve(skillDir, 'SKILL.md');
          if (!existsSync(skillMdPath)) continue;
          if (seen.has(entry.name)) continue;
          seen.add(entry.name);

          try {
            const content = readFileSync(skillMdPath, 'utf-8');
            // 解析 SKILL.md frontmatter
            const nameMatch = content.match(/^name:\s*(.+)$/m);
            const descMatch = content.match(/^description:\s*(.+)$/m);
            // 检查 agents/openai.yaml
            const yamlPath = resolve(skillDir, 'agents', 'openai.yaml');
            const hasYaml = existsSync(yamlPath);
            const isLocal = basename(dir) === 'skills' && dir === resolve(process.cwd(), 'skills');

            skills.push({
              name: entry.name,
              title: nameMatch?.[1]?.trim() || entry.name,
              description: descMatch?.[1]?.trim() || '',
              path: skillDir,
              source: basename(dir),
              isLocal, // 项目内导入的才能删除
              hasYaml,
              installed: true,
              enabled: state[entry.name] !== false, // 默认启用
            });
          } catch { /* skip corrupt skill */ }
        }
      } catch { /* skip unreadable dir */ }
    }

    return skills;
  });

  // 安装技能（从源复制到项目）
  app.post('/api/skills/:name/install', {
    schema: { description: '安装指定技能', tags: ['技能'] },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    // P0-9: 路径穿越防护（修复：homedir/mkdirSync/resolve 已顶部 import，无需 dynamic import）
    if (!name || basename(name) !== name || name.includes('..')) {
      return reply.code(400).send({ error: '非法技能名称' });
    }

    // 搜索技能源目录
    const searchPaths = [
      resolve(homedir(), '.config', 'opencode', 'skills', name),
      resolve(homedir(), '.codex', 'skills', name),
    ];

    let sourceDir = '';
    for (const p of searchPaths) {
      if (existsSync(resolve(p, 'SKILL.md'))) { sourceDir = p; break; }
    }
    if (!sourceDir) return { error: `技能 "${name}" 未找到` };

    // 复制到项目 skills 目录
    const projectSkillsDir = resolve(process.cwd(), 'skills', name);
    if (!existsSync(projectSkillsDir)) mkdirSync(projectSkillsDir, { recursive: true });

    const copyDir = (src: string, dest: string) => {
      if (!existsSync(src)) return;
      const entries = readdirSync(src, { withFileTypes: true });
      for (const entry of entries) {
        const srcPath = resolve(src, entry.name);
        const destPath = resolve(dest, entry.name);
        if (entry.isDirectory()) {
          if (!existsSync(destPath)) mkdirSync(destPath, { recursive: true });
          copyDir(srcPath, destPath);
        } else {
          copyFileSync(srcPath, destPath);
        }
      }
    };
    copyDir(sourceDir, projectSkillsDir);

    return { success: true, name, path: projectSkillsDir };
  });

  // 删除技能（删除技能目录；全局技能删除前需用户确认）
  app.delete('/api/skills/:name', {
    schema: { description: '删除技能', tags: ['技能'] },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    // P0-9: 路径穿越防护 — name 必须是纯 basename，不含路径分隔符
    if (!name || basename(name) !== name || name.includes('..')) {
      return reply.code(400).send({ error: '非法技能名称' });
    }
    // 在多个可能位置查找
    const searchPaths = [
      resolve(process.cwd(), 'skills', name),                 // 项目内导入
      resolve(homedir(), '.config', 'opencode', 'skills', name), // 全局 opencode
      resolve(homedir(), '.codex', 'skills', name),           // 全局 codex
      resolve(process.cwd(), '.opencode', 'skills', name),
      resolve(process.cwd(), '.codex', 'skills', name),
    ];
    let deletedPath = '';
    for (const p of searchPaths) {
      if (existsSync(p)) {
        rmSync(p, { recursive: true, force: true });
        deletedPath = p;
      }
    }
    if (!deletedPath) {
      return { error: `技能 "${name}" 未找到` };
    }
    return { success: true, name, removed: deletedPath };
  });

  // 启用/禁用技能
  app.put('/api/skills/:name/toggle', {
    schema: {
      description: '启用或禁用指定技能',
      tags: ['技能'],
      params: { type: 'object', properties: { name: { type: 'string' } } },
      body: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' } } },
    },
  }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const { enabled } = request.body as { enabled: boolean };
    if (!name || basename(name) !== name || name.includes('..')) {
      return reply.code(400).send({ error: '非法技能名称' });
    }
    const state = loadSkillsState(config);
    state[name] = enabled;
    saveSkillsState(config, state);
    return { success: true, name, enabled };
  });
}