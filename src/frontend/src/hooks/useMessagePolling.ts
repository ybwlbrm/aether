import { useEffect, useRef, useCallback } from 'react';
import { api } from '../api/client';
import { fetchEvents } from '../api/streamClient';
import { useActivityStore } from '../store/activityStore';

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  reasoning?: string | null;
  createdAt: string;
  toolCalls?: string | null;
}

export interface UseMessagePollingOptions {
  /** Current conversation ID */
  conversationId: string | null;
  /** Whether polling is enabled (e.g., only when sending) */
  enabled?: boolean;
  /** Polling interval in ms (default: 1000 for CodingHome, 2000 for Chat) */
  intervalMs?: number;
  /** Called to update messages with merged server data */
  onMessagesUpdate: (updater: (prev: Message[]) => Message[]) => void;
  /** Called when token total updates */
  onTokenTotalUpdate?: (total: number) => void;
  /** Called when sending state should update based on server status */
  onSendingUpdate?: (generating: boolean) => void;
  /** Called when live reasoning should update from server */
  onLiveReasoningUpdate?: (reasoning: string) => void;
  /** Current conversation ref (for race condition guards) */
  currentConvRef: React.MutableRefObject<string | null>;
  /** Message poll request ID ref (for FE-04/FE-08: request sequence guard) */
  msgPollReqIdRef: React.MutableRefObject<number>;
  /** Activity poll request ID ref (separate from message polling to avoid interference) */
  activityPollReqIdRef?: React.MutableRefObject<number>;
  /** Mounted ref (for cleanup on unmount) */
  mountedRef?: React.MutableRefObject<boolean>;
  /** Whether to also poll activity events (for Chat.tsx) */
  pollActivityEvents?: boolean;
  /** Activity store last sequence getter */
  getLastSeq?: (convId: string) => number;
  /** Called when polling error occurs (FE-ERR-06: expose errors instead of silent catch) */
  onPollError?: (error: Error, type: 'message' | 'activity') => void;
}

/**
 * Shared hook for message polling with request sequence guard (FE-04/FE-08):
 * - Polls conversation messages at configurable interval
 * - Merges server messages with local optimistic messages by ID
 * - Request sequence guard discards stale responses
 * - Updates token total, sending state, and live reasoning from server
 * - Optionally polls activity events (for Chat.tsx)
 * - FE-RACE-01: Separate request ID refs for message vs activity polling
 * - FE-ERR-06: Expose polling errors via onPollError callback
 */
export function useMessagePolling(options: UseMessagePollingOptions) {
  const {
    conversationId,
    enabled = true,
    intervalMs = 1000,
    onMessagesUpdate,
    onTokenTotalUpdate,
    onSendingUpdate,
    onLiveReasoningUpdate,
    currentConvRef,
    msgPollReqIdRef,
    activityPollReqIdRef,
    mountedRef,
    pollActivityEvents = false,
    getLastSeq,
    onPollError,
  } = options;

  const notifiedRef = useRef(false);

  const poll = useCallback(async () => {
    const convId = conversationId;
    if (!convId || !enabled) return;

    const reqId = ++msgPollReqIdRef.current;
    if (mountedRef && !mountedRef.current) return;

    try {
      const conv = await api.getConversation(convId);
      if (mountedRef && !mountedRef.current) return;
      if (reqId !== msgPollReqIdRef.current) return; // FE-04/FE-08: discard stale
      if (currentConvRef.current !== convId) return; // FE-04: conversation switched

      // Merge messages: server messages replace local optimistic ones
      onMessagesUpdate(prev => {
        const parseMsg = (m: any): Message => {
          let reasoning: string | undefined;
          if (m.toolResults) {
            try { const tr = JSON.parse(m.toolResults); if (tr.reasoning) reasoning = tr.reasoning; } catch {}
          }
          return {
            id: m.id,
            role: m.role,
            content: m.content,
            createdAt: m.createdAt,
            reasoning,
            toolCalls: m.toolCalls || null,
          };
        };

        const serverMessages: Message[] = (conv.messages || []).map(parseMsg);
        const serverMap = new Map<string, Message>(serverMessages.map(m => [m.id, m]));

        // Start with local messages, replace with server where IDs match
        const merged = prev.map(localMsg => serverMap.get(localMsg.id) || localMsg);

        // Add any server messages not in local (new messages from other clients)
        for (const sm of serverMessages) {
          if (!prev.some(m => m.id === sm.id)) {
            // Try to find optimistic placeholder to replace
            const optIdx = merged.findIndex(m =>
              (m.id.startsWith('u-') || m.id.startsWith('a-') || m.id.startsWith('remote-u-') || m.id.startsWith('temp-')) && m.role === sm.role
            );
            if (optIdx !== -1) {
              merged[optIdx] = sm;
            } else {
              merged.push(sm);
            }
          }
        }

        return merged;
      });

      // Update token total
      if (typeof conv.tokenTotal === 'number') {
        onTokenTotalUpdate?.(conv.tokenTotal);
      }

      // Check generation status
      try {
        const statusRes = await fetch(`/api/conversations/${convId}/status`, {
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        const status = await statusRes.json();
        if (reqId !== msgPollReqIdRef.current) return;
        if (currentConvRef.current !== convId) return;

        if (!status.generating && !notifiedRef.current && document.hidden) {
          notifiedRef.current = true;
          onSendingUpdate?.(false);
        } else if (!status.generating) {
          onSendingUpdate?.(false);
          notifiedRef.current = false; // 重置，下次生成完成时再通知
        } else if (status.generating) {
          onSendingUpdate?.(true);
        }
      } catch { /* ignore */ }

      // Update live reasoning from latest message
      const latestMsg = conv.messages?.[conv.messages.length - 1];
      if (latestMsg?.toolResults) {
        try {
          const tr = JSON.parse(latestMsg.toolResults);
          if (tr.reasoning) {
            onLiveReasoningUpdate?.(tr.reasoning);
          }
        } catch { /* ignore */ }
      }
    } catch (e) {
      // FE-ERR-06: 不再静默吞错，通过回调向上层暴露
      if (e instanceof Error) {
        onPollError?.(e, 'message');
      }
    }
  }, [
    conversationId,
    enabled,
    onMessagesUpdate,
    onTokenTotalUpdate,
    onSendingUpdate,
    onLiveReasoningUpdate,
    currentConvRef,
    msgPollReqIdRef,
    mountedRef,
    onPollError,
  ]);

  const pollActivity = useCallback(async () => {
    const convId = conversationId;
    if (!convId || !pollActivityEvents || !getLastSeq) return;

    // 使用独立的 activityPollReqIdRef，避免与消息轮询互相干扰 (FE-RACE-01)
    const activityRef = activityPollReqIdRef ?? msgPollReqIdRef;
    const reqId = ++activityRef.current;
    if (mountedRef && !mountedRef.current) return;

    try {
      const lastSeq = getLastSeq(convId);
      const events = await fetchEvents(convId, lastSeq);
      if (mountedRef && !mountedRef.current) return;
      if (reqId !== activityRef.current) return;
      if (currentConvRef.current !== convId) return;

      if (events.length > 0) {
        useActivityStore.getState().appendEvents(convId, events);
      }
    } catch (e) {
      // FE-ERR-06: 活动轮询错误也暴露出去
      if (e instanceof Error) {
        onPollError?.(e, 'activity');
      }
    }
  }, [conversationId, pollActivityEvents, getLastSeq, currentConvRef, activityPollReqIdRef, msgPollReqIdRef, mountedRef, onPollError]);

  // Main message polling
  useEffect(() => {
    if (!conversationId || !enabled) return;

    let cancelled = false;
    notifiedRef.current = false;

    const runPoll = async () => {
      if (cancelled) return;
      await poll();
    };

    runPoll();
    const interval = setInterval(runPoll, intervalMs);
    return () => { cancelled = true; clearInterval(interval); };
  }, [conversationId, enabled, intervalMs, poll]);

  // Activity events polling (Chat.tsx)
  useEffect(() => {
    if (!conversationId || !pollActivityEvents) return;

    let cancelled = false;

    const runPollActivity = async () => {
      if (cancelled) return;
      await pollActivity();
    };

    runPollActivity();
    const interval = setInterval(runPollActivity, 2000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [conversationId, pollActivityEvents, pollActivity]);
}