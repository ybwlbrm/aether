export interface NodeExecutionResult {
  readonly output: string
  readonly data?: unknown
  readonly error?: string
}

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
  /**
   * §42 修复：条件边显式化 —— 不再依赖"第一条边=true / 第二条边=false"的隐式约定。
   * condition: 可选布尔表达式语义（'passed' = data.passed 为真时走此边；'failed' = 为假时走此边）。
   * 缺省 = 无条件（总是走此边）。
   */
  condition?: 'passed' | 'failed';
}
