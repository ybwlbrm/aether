import type { WorkflowNode } from './types.js';
import type { BackendConfig } from '../../config/index.js';
import { getProviderById, getProviderByCapability } from '../../lib/provider.js';
import { buildModelRuntime } from '../../core/models/index.js';
import { ModelError } from '../../core/errors/index.js';
import { getPptxgen, getDocx, extractJson } from '../documents/index.js';
import { executeFileTool } from '../../lib/files.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { getSettings } from '../../lib/dal.js';
import { executeCommand } from '../../lib/command.js';
import { isSafeFetchUrl } from '../../lib/safe-fetch.js';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/** 执行单个节点，返回该节点的输出 */
export async function executeNode(
  node: WorkflowNode,
  config: BackendConfig,
  context: Record<string, unknown>,
): Promise<{ output: string; data?: unknown }> {
  const cfg = node.config || {};
  switch (node.type) {
    case 'tool': {
      // 工具节点：调用文件工具（executeFileTool）
      const name = String(cfg.name || '');
      if (!name) return { output: '工具节点缺少 name 配置' };
      const settings = await getSettings();
      const allowedDirs = Array.isArray(settings.allowedDirs) && settings.allowedDirs.length > 0
        ? settings.allowedDirs
        : [process.cwd()];
      const defaultDir = settings.defaultDir || allowedDirs[0] || process.cwd();
      const args = (cfg.args && typeof cfg.args === 'object' ? cfg.args : {}) as Record<string, unknown>;
      // 支持 {{prev.<nodeId>}} 模板引用上游输出
      const resolvedArgs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(args)) {
        if (typeof v === 'string') {
          resolvedArgs[k] = v.replace(/\{\{prev\.([\w-]+)\}\}/g, (_, id: string) => {
            const prev = context[id];
            return prev !== undefined ? String(prev) : '';
          });
        } else {
          resolvedArgs[k] = v;
        }
      }
      // P0-7 修复：executeFileTool 是 async 函数，需 await —
      // 原代码未 await，output 是 Promise 对象而非文件内容，破坏下游节点引用
      const output = await executeFileTool(name, resolvedArgs, allowedDirs, defaultDir, settings.permissionLevel);
      return { output };
    }
    case 'agent': {
      // Agent 节点：调用 AI（chat/completions）
      const prompt = String(cfg.prompt || '请根据上下文执行任务');
      const providerId = cfg.providerId ? String(cfg.providerId) : undefined;
      const model = cfg.model ? String(cfg.model) : undefined;
      let provider = providerId ? getProviderById(providerId, config.encryptionKey) : null;
      if (!provider) provider = getProviderByCapability('text', config.encryptionKey);
      if (!provider) return { output: '未配置 AI Provider，无法执行 Agent 节点' };
      // SSRF 防护：校验 provider.baseUrl
      if (!provider.baseUrl || !isSafeFetchUrl(provider.baseUrl)) {
        return { output: '安全限制：Provider baseUrl 存在 SSRF 风险（链路本地/元数据地址或非 http(s) 协议）' };
      }
      try {
        // P0-12（§六十四）：业务层经 ModelRuntime → ProviderAdapter → HTTP，
        // 不再直接 fetch /chat/completions。buildModelRuntime 用解密后的 apiKey
        // 构造 OpenAICompatibleAdapter（allowHttpTransport: true，SSRF 校验已在上方保留）。
        const runtime = buildModelRuntime(provider);
        const response = await runtime.complete({
          provider: provider.id,
          model: model || provider.defaultModel,
          messages: [{ role: 'user', content: prompt }],
          maxTokens: Number(cfg.maxTokens || 2048),
        });
        const text = response.content.trim();
        return { output: text || '(空回复)' };
      } catch (e: unknown) {
        const status = e instanceof ModelError && e.statusCode !== undefined ? ` (${e.statusCode})` : '';
        const message = e instanceof Error ? e.message : String(e);
        return { output: `AI 调用失败${status}: ${message.slice(0, 300)}` };
      }
    }
    case 'media': {
      // 媒体节点：调用 AI 生成 API
      const prompt = String(cfg.prompt || '');
      const mediaType = String(cfg.type || 'image');
      if (!prompt) return { output: '媒体节点缺少 prompt 配置' };
      const provider = getProviderByCapability(mediaType === 'video' ? 'video' : 'image', config.encryptionKey);
      if (!provider?.apiKey) return { output: '未配置 AI Provider，无法生成媒体' };
      // SSRF 防护：校验 provider.baseUrl
      if (!provider.baseUrl || !isSafeFetchUrl(provider.baseUrl)) {
        return { output: '安全限制：Provider baseUrl 存在 SSRF 风险（链路本地/元数据地址或非 http(s) 协议）' };
      }
      try {
        const baseUrl = provider.baseUrl?.replace(/\/+$/, '') || '';
        const apiBody: Record<string, unknown> = {
          model: String(cfg.model || provider.defaultModel || 'dall-e-3'),
          prompt, n: 1, size: String(cfg.size || '1024x1024'),
        };
        // P0-12（§六十四）说明：Media 节点的端点是 OpenAI 专有的
        // /images/generations 与 /videos，而 ProviderAdapter 只实现
        // /chat/completions 一个运维原语，无法经 ModelRuntime 转发媒体端点。
        // 因此此节点保留 fetchWithRetry + 上方 SSRF 校验（isSafeFetchUrl），
        // 不做无意义的 adapter 扩展——媒体端点不属于 chat 完成语义。
        const endpoint = mediaType === 'video' ? '/videos' : '/images/generations';
        const res = await fetchWithRetry(`${baseUrl}${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` },
          body: JSON.stringify(apiBody),
          signal: AbortSignal.timeout(120000),
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          return { output: `${mediaType} 生成失败 (${res.status}): ${errText.slice(0, 200)}` };
        }
        const data = await res.json() as any;
        const imageUrl = data?.data?.[0]?.url || data?.url || '';
        return { output: `${mediaType === 'video' ? '视频' : '图片'}生成成功: ${imageUrl ? imageUrl.slice(0, 100) : prompt.slice(0, 50)}`, data: { url: imageUrl } };
      } catch (e: unknown) {
        return { output: `媒体生成异常: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    case 'document': {
      // 文档节点：调用 AI 生成内容，然后创建实际的文件（PPTX/DOCX）
      const title = String(cfg.title || '未命名文档');
      const kind = String(cfg.kind || 'doc');
      const provider = getProviderByCapability('text', config.encryptionKey);
      if (!provider?.apiKey) return { output: '未配置 AI Provider，无法生成文档' };
      // SSRF 防护：校验 provider.baseUrl
      if (!provider.baseUrl || !isSafeFetchUrl(provider.baseUrl)) {
        return { output: '安全限制：Provider baseUrl 存在 SSRF 风险（链路本地/元数据地址或非 http(s) 协议）' };
      }
      try {
        const model = String(cfg.model || provider.defaultModel || 'gpt-4o');
        const systemPrompt = kind === 'ppt'
          ? '你是专业的演示文稿内容策划。根据标题生成 PPT 幻灯片大纲，返回 JSON 格式：{"slides":[{"title":"...","content":"..."}]}，用简体中文。'
          : '你是专业的文档撰写助手。根据标题生成文章大纲，返回 JSON 格式：{"sections":[{"heading":"...","body":"..."}]}，用简体中文。';
        // P0-12（§六十四）：业务层经 ModelRuntime → ProviderAdapter → HTTP，
        // 不再直接 fetch /chat/completions（systemPrompt 由 ModelRequest 携带）。
        let text: string;
        try {
          const runtime = buildModelRuntime(provider);
          const response = await runtime.complete({
            provider: provider.id,
            model,
            systemPrompt,
            messages: [{ role: 'user', content: `文档标题: ${title}` }],
            maxTokens: 2048,
          });
          text = response.content.trim();
        } catch (aiErr: unknown) {
          const status = aiErr instanceof ModelError && aiErr.statusCode !== undefined ? ` (${aiErr.statusCode})` : '';
          return { output: `文档生成失败${status}` };
        }
        // 解析 AI 输出并创建实际文件
        const docDir = resolve(config.dataDir, 'documents');
        if (!existsSync(docDir)) mkdirSync(docDir, { recursive: true });
        const fileName = `${randomUUID()}.${kind === 'ppt' ? 'pptx' : 'docx'}`;
        const filePath = resolve(docDir, fileName);
        try {
          if (kind === 'ppt') {
            const pptx = new (await getPptxgen())();
            pptx.layout = 'LAYOUT_16x9';
            pptx.author = 'AI Workflow';
            pptx.title = title;
            const parsed = extractJson(text);
            const slides = parsed?.slides || [{ title, content: text }];
            slides.forEach((item: any, i: number) => {
              const slide = pptx.addSlide();
              slide.background = { color: 'F3F4F6' };
              slide.addText(item.title || `第 ${i + 1} 页`, { x: 0.5, y: 0.4, w: 9, h: 0.9, fontSize: i === 0 ? 36 : 28, bold: true, color: '1F2937', fontFace: 'Microsoft YaHei' });
              slide.addText(item.content || '', { x: 0.6, y: 1.5, w: 8.8, h: 4.9, fontSize: i === 0 ? 20 : 16, color: '374151', fontFace: 'Microsoft YaHei', valign: 'top' });
            });
            const buffer = await (pptx as unknown as { write(format: 'nodebuffer'): Promise<Buffer> }).write('nodebuffer');
            writeFileSync(filePath, buffer);
          } else {
            const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await getDocx();
            const children: InstanceType<typeof Paragraph>[] = [];
            children.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE, spacing: { after: 300 } }));
            const parsed = extractJson(text);
            const sections = parsed?.sections || [{ heading: title, body: text }];
            sections.forEach((section: any) => {
              children.push(new Paragraph({ text: section.heading || '章节', heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 120 } }));
              const body = section.body || '';
              body.split('\n').forEach((line: string) => {
                const trimmed = line.trim();
                if (!trimmed) return;
                children.push(new Paragraph({ children: [new TextRun({ text: trimmed, size: 24 })], spacing: { after: 120 } }));
              });
            });
            const docx = new Document({ creator: 'AI Workflow', title, sections: [{ children }] });
            const buffer = await Packer.toBuffer(docx);
            writeFileSync(filePath, buffer);
          }
          return { output: `${kind === 'ppt' ? 'PPT' : '文档'}生成成功: ${title}`, data: { path: filePath } };
        } catch (fileErr) {
          return { output: `文档文件创建失败: ${fileErr instanceof Error ? fileErr.message : String(fileErr)}` };
        }
      } catch (e: unknown) {
        return { output: `文档生成异常: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    case 'condition': {
      // 条件节点：根据表达式判断走向（简单支持 truthy / 比较）
      const expr = String(cfg.expression || '');
      const value = String(cfg.value ?? '');
      let result = false;
      if (expr === 'truthy') {
        result = Boolean(value && value !== 'false' && value !== '0');
      } else if (expr === 'equals') {
        result = value === String(cfg.compare ?? '');
      } else if (expr === 'contains') {
        result = value.includes(String(cfg.compare ?? ''));
      } else {
        result = Boolean(value);
      }
      return { output: `条件判断: ${expr || 'truthy'} → ${result ? '通过' : '不通过'}`, data: { passed: result } };
    }
    case 'system': {
      // 系统命令节点：执行 shell 命令（如音量控制、打开程序等）
      // 使用 lib/command.ts 的 executeCommand（spawn + shell:false，内建命令原生实现）
      const cmd = String(cfg.command || '');
      if (!cmd) return { output: '系统节点缺少 command 配置' };
      try {
        const settings = await getSettings();
        const permLevel = settings.permissionLevel ?? 2;
        const allowedDirs = settings.allowedDirs || [];
        const defaultDir = settings.defaultDir || allowedDirs[0] || process.cwd();
        const output = await executeCommand(cmd, defaultDir, 30000, allowedDirs, permLevel, defaultDir);
        return { output };
      } catch (e: unknown) {
        return { output: `系统命令执行异常: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    default:
      return { output: `未知节点类型: ${node.type}` };
  }
}