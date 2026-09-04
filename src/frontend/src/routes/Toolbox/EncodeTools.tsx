import { useState, useRef } from 'react';
import { Binary, Upload, Download, X, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import type { ConvertOption } from './types';

interface EncodeToolsProps {
  selected: ConvertOption;
  onBack: () => void;
  onConvert: () => void;
  converting: boolean;
  progress: number;
  encodeInput: string;
  setEncodeInput: (v: string) => void;
  encodeOutput: string;
  setEncodeOutput: (v: string) => void;
  encodeError: string | null;
  setEncodeError: (v: string | null) => void;
  encodeDirection: 'encode' | 'decode';
  setEncodeDirection: (v: 'encode' | 'decode') => void;
  encodeEncoding: 'utf8' | 'gbk' | 'big5' | 'gb18030' | 'unicode';
  setEncodeEncoding: (v: 'utf8' | 'gbk' | 'big5' | 'gb18030' | 'unicode') => void;
  codecFormat: 'hex' | 'unicode' | 'base64';
  setCodecFormat: (v: 'hex' | 'unicode' | 'base64') => void;
  imgBase64Ref: React.RefObject<HTMLInputElement | null>;
}

export function EncodeTools({
  selected, onBack, onConvert, converting, progress,
  encodeInput, setEncodeInput, encodeOutput, setEncodeOutput,
  encodeError, setEncodeError,
  encodeDirection, setEncodeDirection,
  encodeEncoding, setEncodeEncoding,
  codecFormat, setCodecFormat,
  imgBase64Ref
}: EncodeToolsProps) {
  return (
    <>
      {selected.op === 'image-to-base64' ? (
        <>
          <input ref={imgBase64Ref} type="file" accept="image/*" style={{ display: 'none' }}
            onChange={e => {
              const file = e.target.files?.[0];
              if (!file) return;
              const reader = new FileReader();
              reader.onload = () => { setEncodeOutput(reader.result as string); setEncodeError(null); };
              reader.readAsDataURL(file);
              e.target.value = '';
            }} />
          <button className="btn btn-primary" onClick={() => imgBase64Ref.current?.click()} style={{ marginBottom: 12 }}>
            <Upload size={18} /> 选择图片
          </button>
          <p style={{ fontSize: 'var(--font-xs)', color: 'var(--text-tertiary)', marginBottom: 12 }}>支持 PNG/JPG/WEBP/GIF，转换为 Data URL 格式</p>
        </>
      ) : (
        <textarea className="input textarea" rows={4} value={encodeInput}
          onChange={e => setEncodeInput(e.target.value)}
          placeholder={selected.op === 'to-utf8' ? (encodeDirection === 'encode' ? '输入中文/文字，转换编码…' : '输入编码（hex / \\u 转义 / Base64），解码为文字…') : '输入文本或 Base64 字符串…'}
          style={{ marginBottom: 16, fontFamily: 'var(--font-mono)', fontSize: 13 }} />
      )}
      {selected.op !== 'image-to-base64' && (
        <button className="btn btn-primary" onClick={onConvert} disabled={!encodeInput}>
          <Binary size={18} /> {selected.op === 'to-utf8' ? (encodeDirection === 'encode' ? '文字 → 编码' : '编码 → 文字') : '编解码'}
        </button>
      )}
      {selected.op === 'to-utf8' && (
        <>
          {/* 方向切换 */}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            {(['encode', 'decode'] as const).map(dir => (
              <button key={dir} onClick={() => setEncodeDirection(dir)}
                className="btn btn-secondary btn-sm"
                style={{
                  fontSize: 12,
                  background: encodeDirection === dir ? 'var(--color-accent)' : undefined,
                  color: encodeDirection === dir ? '#fff' : 'var(--text-secondary)',
                  border: encodeDirection === dir ? '1px solid var(--color-accent)' : '1px solid var(--input-border)',
                }}>
                {dir === 'encode' ? '文字 → 编码' : '编码 → 文字'}
              </button>
            ))}
          </div>
          {/* 编码选择 */}
          <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>编码:</span>
            {(['utf8', 'gbk', 'big5', 'gb18030', 'unicode'] as const).map(enc => (
              <button key={enc} onClick={() => setEncodeEncoding(enc)}
                className="btn btn-secondary btn-sm"
                style={{
                  fontSize: 11,
                  background: encodeEncoding === enc ? 'var(--color-accent)' : undefined,
                  color: encodeEncoding === enc ? '#fff' : 'var(--text-secondary)',
                  border: encodeEncoding === enc ? '1px solid var(--color-accent)' : '1px solid var(--input-border)',
                  padding: '2px 8px',
                }}>
                {enc.toUpperCase()}
              </button>
            ))}
          </div>
          {/* 格式选择 */}
          <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>格式:</span>
            {(['hex', 'unicode', 'base64'] as const).map(fmt => (
              <button key={fmt} onClick={() => setCodecFormat(fmt)}
                className="btn btn-secondary btn-sm"
                style={{
                  fontSize: 11,
                  background: codecFormat === fmt ? 'var(--color-accent)' : undefined,
                  color: codecFormat === fmt ? '#fff' : 'var(--text-secondary)',
                  border: codecFormat === fmt ? '1px solid var(--color-accent)' : '1px solid var(--input-border)',
                  padding: '2px 8px',
                }}>
                {fmt === 'hex' ? '十六进制' : fmt === 'unicode' ? 'Unicode 转义' : 'Base64'}
              </button>
            ))}
          </div>
          <p style={{ fontSize: 'var(--font-xs)', color: 'var(--text-tertiary)', marginTop: 8 }}>
            文字→编码：输入「你好」选 UTF-8 → e4bda0e5a5bd 或 \u4f60\u597d；编码→文字：输入编码可还原。GBK/Big5/gb18030 需服务端处理
          </p>
        </>
      )}
      {encodeOutput && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-secondary)', marginBottom: 8 }}>结果：</div>
          <textarea className="input textarea" rows={4} value={encodeOutput} readOnly
            onClick={e => (e.target as HTMLTextAreaElement).select()}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn btn-secondary btn-sm" onClick={() => navigator.clipboard.writeText(encodeOutput)}>复制结果</button>
            <button className="btn btn-ghost btn-sm" onClick={() => { setEncodeOutput(''); setEncodeInput(''); }}>清空</button>
          </div>
        </div>
      )}
      {encodeError && (
        <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.2)', fontSize: 'var(--font-xs)', color: 'var(--color-danger)' }}>
          {encodeError}
        </div>
      )}
    </>
  );
}