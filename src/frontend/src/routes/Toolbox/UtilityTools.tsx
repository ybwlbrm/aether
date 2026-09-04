import { Download, Loader2 } from 'lucide-react';
import type { ConvertOption } from './types';

interface UtilityToolsProps {
  selected: ConvertOption;
  onConvert: () => void;
  converting: boolean;
  utilityInput: string;
  setUtilityInput: (v: string) => void;
}

export function UtilityTools({ selected, onConvert, converting, utilityInput, setUtilityInput }: UtilityToolsProps) {
  return (
    <>
      <textarea className="input textarea" rows={4} value={utilityInput}
        onChange={e => setUtilityInput(e.target.value)} placeholder="输入要转换的内容..."
        style={{ marginBottom: 16, fontFamily: 'var(--font-mono)', fontSize: 13 }} />
      <button className="btn btn-primary" onClick={onConvert} disabled={converting || !utilityInput}>
        {converting ? <><Loader2 size={18} className="animate-spin" /> 处理中...</> : <><Download size={18} /> {selected.op === 'base64' ? '编解码' : selected.op === 'timestamp' ? '转换' : '转换'}</>}
      </button>
    </>
  );
}