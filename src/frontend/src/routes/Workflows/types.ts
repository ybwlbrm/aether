export type NodeType = 'tool' | 'agent' | 'media' | 'document' | 'condition' | 'system';

export interface FlowNode {
  id: string;
  type: NodeType;
  label: string;
  config: Record<string, unknown>;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  trigger: 'manual' | 'schedule' | 'webhook';
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  currentNodeId?: string;
  results: Record<string, {
    label: string
    type: string
    output: string
    data?: unknown
    status: 'completed' | 'failed' | 'cancelled'
    error?: string
    /** 机器可读失败码（AEX-P0-017） */
    code?: string
  }>;
  /** 节点级执行态（AEX-P0-015）—— 与 results 的聚合快照不同，这是每节点一行的事实源 */
  nodeRuns?: NodeRunRecord[];
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export interface NodeRunRecord {
  nodeId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  attempt: number;
  retryCount: number;
  output?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface NodeMeta {
  label: string;
  color: string;
  icon: React.ReactNode;
  desc: string;
}