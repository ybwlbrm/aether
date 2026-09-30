/**
 * T24 · ThreadPage 的 Composer 组合（T18）。
 *
 * ## 为什么独立成文件
 * 输入区的**接线**（哪些动作开、门控到哪）与 ThreadPage 的**编排**（会话 / run /
 * 事件）是两件事。合成一个文件时权限等级、plus 菜单、附件托盘这些纯展示细节会把
 * 编排逻辑埋掉；拆开后本页只剩"把 hook 出参接到 JSX"，而这份文件只剩"接哪个、门控到哪"。
 *
 * ## 能力门控
 * 五个次级动作全部经 `profile` 逐个门控，且沿用 T18 各自的门控语义 ——
 * 能力关时对应组件**零 DOM**（VoiceButton / AttachmentTray / ProviderSelect /
 * PromptTemplates 都有 `enabled` / `supported` 双重门控）。
 */
import type { RefObject } from 'react';
import { MessageSquare, Paperclip, Plus, ShieldCheck } from 'lucide-react';

import { api } from '../api/client';
import {
  AttachmentTray,
  Composer,
  ComposerToolbar,
  PromptTemplates,
  ProviderSelect,
  VoiceButton,
} from '../components/composer';
import type { useAttachments } from '../hooks/useAttachments';
import type { ProviderSelectOption } from '../hooks/useProviderSelection';
import { nextPermissionLevel, type ThreadPageProfile } from './threadPageProfile';

export interface ThreadComposerSlotProps {
  readonly profile: ThreadPageProfile;
  readonly input: string;
  readonly onInputChange: (next: string) => void;
  readonly onSubmit: () => void;
  readonly onStop: () => void;
  readonly sending: boolean;
  /** 重试提示行（null 时不渲染） */
  readonly retryLine: string | null;
  readonly templateOpen: boolean;
  readonly onTemplateOpenChange: (open: boolean) => void;
  readonly voiceError: (message: string) => void;
  readonly attachment: ReturnType<typeof useAttachments>;
  readonly plusMenuOpen: boolean;
  readonly onPlusMenuToggle: () => void;
  readonly onPlusMenuDismiss: () => void;
  readonly onNewConversation: () => void;
  readonly plusRef: RefObject<HTMLDivElement | null>;
  readonly providerSelect: {
    readonly selectedProviderId: string | null;
    readonly options: readonly ProviderSelectOption[];
    readonly onProviderChange: (providerId: string) => void;
  };
  readonly toolbar: {
    readonly mode: 'normal' | 'super';
    readonly onModeChange: (mode: 'normal' | 'super') => void;
    readonly deepThinking: boolean;
    readonly onDeepThinkingToggle: () => void;
    readonly webSearch: boolean;
    readonly onWebSearchToggle: () => void;
    readonly loopMode: boolean;
    readonly onLoopModeToggle: () => void;
  };
  readonly permissionLevel: number;
  readonly onPermissionLevelChange: (level: number) => void;
}

/** 一枚与 Composer 同表面的次级动作按钮：无 pill 底色，仅按下态换主色 */
function plusTriggerStyle(open: boolean) {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 'var(--space-6)',
    height: 'var(--space-6)',
    borderRadius: 'var(--radius-control)',
    border: '1px solid transparent',
    background: 'transparent',
    color: open ? 'var(--color-accent)' : 'var(--text-tertiary)',
    cursor: 'pointer',
    flexShrink: 0,
  } as const;
}

const menuButtonStyle = { justifyContent: 'flex-start', fontSize: 12 } as const;

/** Token / 循环 / 工作目录读数条（loopMetrics 能力的唯一渲染点） */
export interface ThreadStatsBarProps {
  readonly hasMessages: boolean
  readonly messageCount: number
  readonly contextTokens: number
  readonly conversationTokenTotal: number
  readonly streamTokens: number | null
  readonly loopMode: boolean
  readonly sending: boolean
  readonly loopMetrics: {
    readonly turnsUsed: number
    readonly elapsedMs: number
    readonly toolCalls: number
    readonly budgetExceeded: string | null
  } | null
  readonly workspacePath: string
}

export function ThreadStatsBar(props: ThreadStatsBarProps) {
  const {
    hasMessages, messageCount, contextTokens, conversationTokenTotal, streamTokens,
    loopMode, sending, loopMetrics, workspacePath,
  } = props;
  return (
    <div
      data-slot="thread-token-bar"
      style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', padding: '6px 2px 0', fontSize: 11, color: 'var(--text-tertiary)' }}
    >
      {hasMessages && <span>📖 上下文: {contextTokens > 0 ? `${contextTokens.toLocaleString()} tokens` : `${messageCount} 条消息`}</span>}
      {hasMessages && <span>⚡ 对话累计: {conversationTokenTotal > 0 ? `${conversationTokenTotal.toLocaleString()} tokens` : '暂无数据'}</span>}
      {streamTokens !== null && <span>· 本次: {streamTokens.toLocaleString()} tokens</span>}
      {loopMode && loopMetrics !== null && !sending && (
        <span style={{ color: 'var(--color-warning)' }} title={loopMetrics.budgetExceeded ?? undefined}>
          ♾️ {loopMetrics.turnsUsed} 轮 · {(loopMetrics.elapsedMs / 1000).toFixed(1)}s · {loopMetrics.toolCalls} 次工具
          {loopMetrics.budgetExceeded ? ' · ⚠️ 预算耗尽' : ''}
        </span>
      )}
      {workspacePath !== '' && (
        <span>📁 <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}>{workspacePath}</span></span>
      )}
    </div>
  );
}

export function ThreadComposerSlot(props: ThreadComposerSlotProps) {
  const {
    profile, input, onInputChange, onSubmit, onStop, sending, retryLine,
    templateOpen, onTemplateOpenChange, voiceError, attachment,
    plusMenuOpen, onPlusMenuToggle, onPlusMenuDismiss, onNewConversation, plusRef,
    providerSelect, toolbar, permissionLevel, onPermissionLevelChange,
  } = props;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
      {profile.attachment && <input {...attachment.inputProps} style={{ display: 'none' }} />}

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
        <div ref={plusRef} style={{ position: 'relative', flexShrink: 0 }}>
          <button
            type="button"
            aria-label="新建对话或上传文件"
            aria-expanded={plusMenuOpen}
            onClick={onPlusMenuToggle}
            style={plusTriggerStyle(plusMenuOpen)}
          >
            <Plus size={16} strokeWidth={plusMenuOpen ? 2 : 1.75} aria-hidden="true" />
          </button>
          {plusMenuOpen && (
            <div
              data-slot="composer-plus-menu"
              style={{
                position: 'absolute',
                bottom: 'calc(var(--space-6) + 4px)',
                left: 0,
                minWidth: 168,
                zIndex: 'var(--z-sticky)',
                borderRadius: 'var(--radius-control)',
                padding: 4,
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-primary)',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
            >
              <button type="button" onClick={onNewConversation} className="btn btn-ghost btn-sm" style={menuButtonStyle}>
                <MessageSquare size={14} /> 新建对话
              </button>
              {profile.attachment && (
                <button
                  type="button"
                  onClick={() => { onPlusMenuDismiss(); attachment.openPicker(); }}
                  className="btn btn-ghost btn-sm"
                  style={menuButtonStyle}
                >
                  <Paperclip size={14} /> 上传文件
                </button>
              )}
            </div>
          )}
        </div>

        <AttachmentTray
          items={attachment.attachments}
          onRemove={attachment.remove}
          enabled={profile.attachment}
          disabled={sending}
        />
      </div>

      <Composer
        value={input}
        onChange={onInputChange}
        onSubmit={onSubmit}
        onStop={onStop}
        sending={sending}
        disabled={false}
        error={retryLine}
        after={(
          <>
            {profile.voice && (
              <VoiceButton value={input} onChange={onInputChange} disabled={sending} onError={voiceError} />
            )}
            <PromptTemplates
              open={templateOpen}
              onOpenChange={onTemplateOpenChange}
              onSelect={(content) => { onInputChange(content); }}
              currentInput={input}
              enabled={profile.capabilities.promptTemplates}
            />
            <ProviderSelect
              selectedProviderId={providerSelect.selectedProviderId}
              options={providerSelect.options}
              onProviderChange={providerSelect.onProviderChange}
              enabled={profile.providerSelect}
            />
            <ComposerToolbar mode={{ mode: toolbar.mode, onModeChange: toolbar.onModeChange }} toggles={toolbar} />
            {profile.permissionLevel && (
              <button
                type="button"
                aria-label="切换权限等级"
                title={`权限等级 ${permissionLevel}（点击切换）`}
                onClick={() => {
                  const next = nextPermissionLevel(permissionLevel);
                  api.setPermissions(next).then(() => { onPermissionLevelChange(next); }).catch(() => {});
                }}
                style={{
                  ...plusTriggerStyle(false),
                  borderColor: 'var(--border-primary)',
                  background: 'var(--bg-surface)',
                }}
              >
                <ShieldCheck size={16} strokeWidth={1.75} aria-hidden="true" />
                <span style={{ fontSize: 10, marginLeft: 2 }}>L{permissionLevel}</span>
              </button>
            )}
          </>
        )}
      />
    </div>
  );
}
