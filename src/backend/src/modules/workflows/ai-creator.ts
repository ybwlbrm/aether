import type { BackendConfig } from '../../config/index.js';
import { getProviderByCapability } from '../../lib/provider.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { extractJson } from '../documents/index.js';
import { isSafeFetchUrl } from '../../lib/safe-fetch.js';
import { randomUUID } from 'node:crypto';
import { getDb, saveDb } from '../../db/client.js';
import { workflows } from '../../db/schema/index.js';
import { eq } from 'drizzle-orm';
import type { WorkflowNode, WorkflowEdge } from './types.js';

export interface AiCreateWorkflowOptions {
  description: string;
  name?: string;
  config: BackendConfig;
}

export interface AiCreateWorkflowResult {
  id: string;
  name: string;
  description: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  trigger: 'manual';
  createdAt: string;
  updatedAt: string;
  aiGenerated: true;
}

/** AI 辅助创建工作流：用户用自然语言描述需求，AI 生成完整工作流 */
export async function aiCreateWorkflow(opts: AiCreateWorkflowOptions): Promise<AiCreateWorkflowResult> {
  const { description, name, config } = opts;
  const desc = (description || '').trim();
  if (!desc) throw new Error('请描述你想做的工作流');

  const provider = getProviderByCapability('text', config.encryptionKey);
  if (!provider?.apiKey) throw new Error('未配置 AI Provider，无法使用 AI 辅助创建');
  // SSRF 防护：校验 provider.baseUrl
  if (!provider.baseUrl || !isSafeFetchUrl(provider.baseUrl)) {
    throw new Error('安全限制：Provider baseUrl 存在 SSRF 风险（链路本地/元数据地址或非 http(s) 协议）');
  }

  const wfName = name?.trim() || desc.slice(0, 30);

  const systemPrompt = `你是一个工作流设计助手。用户会用自然语言描述想实现的功能，你需要生成一个完整的工作流定义。

工作流包含节点（nodes）和边（edges）。节点类型有：
- tool: 文件工具（read_file/write_file/list_files/delete_file/create_directory）
- agent: AI 对话（需要 prompt 配置）
- media: 媒体生成（需要 prompt 和 type:image/video）
- document: 文档生成（需要 title 和 kind:ppt/doc）
- condition: 条件判断（需要 expression:truthy/equals/contains, value, compare）

每个节点格式：{"id":"node-1","type":"agent","label":"AI分析","config":{"prompt":"分析用户需求"}}
边格式：{"id":"edge-1","source":"node-1","target":"node-2"}

只返回 JSON，不要输出其他内容。格式：
{"name":"工作流名称","nodes":[...],"edges":[...]}`;

  const res = await fetchWithRetry(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` },
    body: JSON.stringify({
      model: provider.defaultModel || 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: desc },
      ],
      max_tokens: 2048,
      stream: false,
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`AI 生成失败 (${res.status}): ${errText.slice(0, 200)}`);
  }

  const data = await res.json() as any;
  const rawText = (data.choices?.[0]?.message?.content || '').trim();
  const parsed = extractJson(rawText);

  if (!parsed || !Array.isArray(parsed.nodes)) {
    throw new Error('AI 返回格式不正确，请重试');
  }

  // 确保节点有 id 和 label
  const nodes: WorkflowNode[] = parsed.nodes.map((n: any, i: number) => ({
    id: n.id || `node-${i + 1}`,
    type: n.type || 'agent',
    label: n.label || `节点${i + 1}`,
    config: n.config || {},
  }));

  // 确保边有 id
  const edges: WorkflowEdge[] = (Array.isArray(parsed.edges) ? parsed.edges : []).map((e: any, i: number) => ({
    id: e.id || `edge-${i + 1}`,
    source: e.source,
    target: e.target,
  }));

  const finalName = parsed.name || wfName;
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  db.insert(workflows).values({
    id,
    name: finalName,
    description: desc,
    nodes: JSON.stringify(nodes),
    edges: JSON.stringify(edges),
    trigger: 'manual',
    createdAt: now,
    updatedAt: now,
  }).run();
  saveDb(config);

  return {
    id, name: finalName, description: desc,
    nodes, edges, trigger: 'manual',
    createdAt: now, updatedAt: now,
    aiGenerated: true,
  };
}