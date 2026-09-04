export interface WorkflowNode {
  id: string;
  type: 'tool' | 'agent' | 'media' | 'document' | 'condition' | 'system';
  label: string;
  config: Record<string, unknown>;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
}