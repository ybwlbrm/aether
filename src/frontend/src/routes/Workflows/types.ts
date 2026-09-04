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
  status: 'pending' | 'running' | 'completed' | 'failed';
  currentNodeId?: string;
  results: Record<string, { label: string; type: string; output: string; data?: unknown }>;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export interface NodeMeta {
  label: string;
  color: string;
  icon: React.ReactNode;
  desc: string;
}