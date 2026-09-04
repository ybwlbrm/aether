import { ArrowRight } from 'lucide-react';
import type { FlowNode, NodeType } from './types';
import { NODE_META } from './constants';

interface NodeConfigProps {
  node: FlowNode;
  onChange: (fn: (n: FlowNode) => FlowNode) => void;
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 8, fontSize: 13,
  border: '1px solid var(--input-border)', background: 'var(--input-bg)', color: 'var(--text-primary)',
  outline: 'none', boxSizing: 'border-box',
};

function NodeConfigPanel({ node, onChange }: NodeConfigProps) {
  const meta = NODE_META[node.type];
  const set = (key: string, value: unknown) => onChange(n => ({ ...n, config: { ...n.config, [key]: value } }));
  const setLabel = (label: string) => onChange(n => ({ ...n, label }));

  return (
    <div className="glass-card" style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <div style={{ width: 26, height: 26, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', background: meta.color, color: '#fff' }}>
          {meta.icon}
        </div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>节点配置 · {meta.label}</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>节点名称</label>
          <input style={inputStyle} value={node.label} onChange={e => setLabel(e.target.value)} />
        </div>

        {node.type === 'tool' && (
          <>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>工具名称</label>
              <input style={inputStyle} placeholder="如: read_file / write_file / list_dir"
                value={String(node.config.name || '')} onChange={e => set('name', e.target.value)} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>参数 (JSON)</label>
              <textarea style={{ ...inputStyle, minHeight: 90, fontFamily: 'monospace', resize: 'vertical' }}
                placeholder='{"path": "D:/test.txt"}'
                value={JSON.stringify(node.config.args || {}, null, 2)}
                onChange={e => {
                  try { set('args', JSON.parse(e.target.value)); } catch { /* 非法 JSON 暂不保存 */ }
                }} />
            </div>
          </>
        )}

        {node.type === 'agent' && (
          <>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>提示词</label>
              <textarea style={{ ...inputStyle, minHeight: 110, resize: 'vertical' }}
                placeholder="告诉 AI 做什么…"
                value={String(node.config.prompt || '')} onChange={e => set('prompt', e.target.value)} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Provider ID（留空用默认）</label>
              <input style={inputStyle} placeholder="可选"
                value={String(node.config.providerId || '')} onChange={e => set('providerId', e.target.value)} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>模型（留空用默认）</label>
              <input style={inputStyle} placeholder="可选"
                value={String(node.config.model || '')} onChange={e => set('model', e.target.value)} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>最大 Token</label>
              <input style={inputStyle} type="number" placeholder="2048"
                value={String(node.config.maxTokens || '')} onChange={e => set('maxTokens', Number(e.target.value) || 2048)} />
            </div>
          </>
        )}

        {node.type === 'media' && (
          <>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>类型</label>
              <select style={inputStyle} value={String(node.config.type || 'image')} onChange={e => set('type', e.target.value)}>
                <option value="image">图片</option>
                <option value="video">视频</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>提示词</label>
              <textarea style={{ ...inputStyle, minHeight: 90, resize: 'vertical' }}
                value={String(node.config.prompt || '')} onChange={e => set('prompt', e.target.value)} />
            </div>
          </>
        )}

        {node.type === 'document' && (
          <>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>类型</label>
              <select style={inputStyle} value={String(node.config.kind || 'doc')} onChange={e => set('kind', e.target.value)}>
                <option value="doc">Word 文档</option>
                <option value="ppt">PPT 演示</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>标题</label>
              <input style={inputStyle} value={String(node.config.title || '')} onChange={e => set('title', e.target.value)} />
            </div>
          </>
        )}

        {node.type === 'condition' && (
          <>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>判断方式</label>
              <select style={inputStyle} value={String(node.config.expression || 'truthy')} onChange={e => set('expression', e.target.value)}>
                <option value="truthy">值非空/非 false</option>
                <option value="equals">等于</option>
                <option value="contains">包含</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>输入值</label>
              <input style={inputStyle} placeholder="可用 {{prev.节点ID}} 引用上游输出"
                value={String(node.config.value || '')} onChange={e => set('value', e.target.value)} />
            </div>
            {(node.config.expression === 'equals' || node.config.expression === 'contains') && (
              <div>
                <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>比较值</label>
                <input style={inputStyle} value={String(node.config.compare || '')} onChange={e => set('compare', e.target.value)} />
              </div>
            )}
            <div style={{ marginTop: 12, padding: 10, borderRadius: 10, background: 'var(--bg-surface, rgba(0,0,0,0.05))', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              <strong>分支说明：</strong><br />
              第一条连接 = <span style={{ color: 'var(--color-success)' }}>通过（true）</span>分支<br />
              第二条连接 = <span style={{ color: 'var(--color-danger)' }}>不通过（false）</span>分支<br />
              条件不通过时，false 分支仍会执行
            </div>
          </>
        )}

        {node.type === 'system' && (
          <>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>系统命令</label>
              <textarea style={{ ...inputStyle, minHeight: 80, fontFamily: 'monospace', resize: 'vertical' }}
                placeholder="如: powercfg /setactive 381b4222-fb78-11d3-915d-00c04f72d4e8 (设置音量)&#10;或: start notepad (打开记事本)&#10;或: echo Hello > D:\\test.txt"
                value={String(node.config.command || '')} onChange={e => set('command', e.target.value)} />
            </div>
            <div style={{ marginTop: 8, padding: 10, borderRadius: 10, background: 'rgba(249,115,22,0.08)', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              <strong>⚠️ 安全提示：</strong><br />
              • 禁止执行危险命令（format、del /f、shutdown 等）<br />
              • 命令超时 30 秒自动终止<br />
              • 可用 {'{{prev.节点ID}}'} 引用上游输出作为命令参数
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4, marginTop: 8 }}>常用命令示例</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px', justifyContent: 'flex-start' }}
                  onClick={() => set('command', 'powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]175)"')}>
                  设置系统音量到 100%（PowerShell，无需安装）
                </button>
                <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px', justifyContent: 'flex-start' }}
                  onClick={() => set('command', 'powershell -Command "Add-Type -TypeDefinition \'using System.Runtime.InteropServices; public class Audio { [DllImport(\\"user32.dll\\")] public static extern int keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo); }\' -PassThru | Out-Null; 1..50 | ForEach-Object { [Audio]::keybd_event(175, 0, 0, 0) }"')}>
                  音量加到最大（模拟按键 50 次）
                </button>
                <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px', justifyContent: 'flex-start' }}
                  onClick={() => set('command', 'powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]174)"')}>
                  静音切换
                </button>
                <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px', justifyContent: 'flex-start' }}
                  onClick={() => set('command', 'start notepad')}>
                  打开记事本
                </button>
                <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px', justifyContent: 'flex-start' }}
                  onClick={() => set('command', 'start https://www.google.com')}>
                  打开浏览器访问网址
                </button>
                <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px', justifyContent: 'flex-start' }}
                  onClick={() => set('command', 'tasklist')}>
                  查看正在运行的程序列表
                </button>
              </div>
            </div>
          </>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
          <ArrowRight size={12} /> 上游输出可用 {'{{prev.节点ID}}'} 引用
        </div>
      </div>
    </div>
  );
}

export { NodeConfigPanel as NodeConfig };