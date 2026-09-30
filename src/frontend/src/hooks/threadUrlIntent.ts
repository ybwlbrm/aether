/**
 * T16 · URL 直达意图（Chat 与 CodingHome 共用）。
 *
 * 两条路由都支持 `?new=true`（回到空白新会话），只有 Chat 支持 `?q`（Sisyphus 一次性回复）。
 * 放在控制器之外是因为这段逻辑整段都是"入站请求 → 副作用"，不持有任何会话状态；
 * 拆开后控制器只留一个 `applyUrlIntent(deps, search, homePath)` 调用点。
 */
import { api } from '../api/client';
import { notificationCenter } from '../lib/notification-center';
import { createStreamFailure, type StreamFailure } from './useStreamSend';
import { resolveModel, toProviderOptions, type ProviderOption } from './useProviderSelection';
import { readField } from './threadContract';

export interface UrlIntentDeps {
  /** ?new：清空当前会话（新建/删除后的本地状态一并归零） */
  readonly clearThread: () => void;
  /** 是否启用 Sisyphus 直达（Chat 能力；CodingHome 无此能力） */
  readonly sisyphusDeepLink: () => boolean;
  /** 是否在无 ?q 时自动新建一条会话（Chat 的 handleNew） */
  readonly autoSelectConversation: () => boolean;
  readonly createConversation: (providers: readonly ProviderOption[]) => Promise<void>;
}

export interface SisyphusDeepLinkDeps {
  readonly setActiveConversation: (id: string | null) => void;
  readonly loadMessages: (id: string) => Promise<void>;
  readonly reportFailure: (failure: StreamFailure) => void;
}

const NO_PROVIDER = '尚未配置 AI Provider。请前往左侧“设置” → “AI Provider”添加您的 API Key。';
const NO_PROVIDER_SHORT = '尚未配置 AI Provider。请在设置中添加 API Key 后重试。';

/** 首次提供 provider 的解析（缺失时给独立失败态，不弹窗） */
async function firstProvider(): Promise<ProviderOption | undefined> {
  return toProviderOptions(await api.getProviders().catch(() => []))[0];
}

/**
 * ?q：一次性 Sisyphus 回复（不走流式）。权限请求由 App Shell 统一发起，本路径只负责
 * 建会话 → 请求回复 → 回读消息 → 发一条幂等终态通知。
 */
export async function runSisyphusDeepLink(prompt: string, deps: SisyphusDeepLinkDeps): Promise<void> {
  const provider = await firstProvider();
  if (!provider) {
    deps.reportFailure(createStreamFailure(NO_PROVIDER));
    return;
  }
  const model = resolveModel(provider, '');
  try {
    const created = readField(await api.createConversation({ title: prompt.slice(0, 30), providerId: provider.id, model }), 'id');
    if (created === null) return;
    deps.setActiveConversation(created);
    const res: unknown = await api.sisyphusReply({ prompt, conversationId: created, providerId: provider.id, model });
    const repliedId = readField(res, 'conversationId');
    if (repliedId === null) return;
    await deps.loadMessages(repliedId);
    // P0 通知幂等化：dedupeKey 幂等，重复到达只通知一次
    notificationCenter.notifyOnce({
      id: `sisyphus-url-${repliedId}`,
      type: 'completed',
      title: 'AI 回复完成',
      body: (readField(res, 'reply') ?? readField(res, 'content') ?? prompt).slice(0, 100),
      conversationId: repliedId,
      createdAt: new Date().toISOString(),
      dedupeKey: `run:${repliedId}:completed`,
    });
  } catch (cause: unknown) {
    deps.reportFailure(createStreamFailure(cause));
  }
}

/** ?new（两条路由）/ ?q + autoSelect 新建会话（仅 Chat） */
export async function applyUrlIntent(
  deps: UrlIntentDeps,
  search: string,
  homePath: string,
  deepLink: SisyphusDeepLinkDeps,
): Promise<void> {
  const params = new URLSearchParams(search);
  if (params.get('new') !== 'true') return;
  if (typeof window !== 'undefined') window.history.replaceState({}, '', homePath);
  deps.clearThread();
  const prompt = params.get('q');
  if (prompt) {
    if (deps.sisyphusDeepLink()) await runSisyphusDeepLink(prompt, deepLink);
    return;
  }
  if (!deps.autoSelectConversation()) return;
  const providers = toProviderOptions(await api.getProviders().catch(() => []));
  if (providers.length === 0) {
    deepLink.reportFailure(createStreamFailure(NO_PROVIDER_SHORT));
    return;
  }
  await deps.createConversation(providers);
}
