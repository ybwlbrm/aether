import { useState, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import { PageHeader } from '../components/PageHeader';
import { Wrench, Upload, Download, Loader2, CheckCircle2, AlertCircle, X } from 'lucide-react';
import type { ConvertOption } from './Toolbox/types';
import { ToolboxList } from './Toolbox/ToolboxList';
import { ToolboxProcess } from './Toolbox/ToolboxProcess';
import { convertOptions, categories, catOf } from './Toolbox/constants';

export function Toolbox() {
  const [selected, setSelected] = useState<ConvertOption | null>(null);
  const [activeCategory, setActiveCategory] = useState('all');
  const [files, setFiles] = useState<File[]>([]);
  const [targetFormat, setTargetFormat] = useState('');
  const [utilityInput, setUtilityInput] = useState('');
  const [watermarkText, setWatermarkText] = useState('样本');
  const [quality, setQuality] = useState(80);
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');
  const [converting, setConverting] = useState(false);
  const [progress, setProgress] = useState(0); // 0=未开始, 100=完成；转换中显示等待秒数
  const [elapsedSec, setElapsedSec] = useState(0);
  const [result, setResult] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 编码转换工具状态（在流程页内使用）
  const [encodeInput, setEncodeInput] = useState('');
  const [encodeOutput, setEncodeOutput] = useState('');
  const [encodeError, setEncodeError] = useState<string | null>(null);
  // 双向互转：direction = encode（文字→编码）| decode（编码→文字）；encoding = 目标编码；codecFormat = 编码表示形式
  const [encodeDirection, setEncodeDirection] = useState<'encode' | 'decode'>('encode');
  const [encodeEncoding, setEncodeEncoding] = useState<'utf8' | 'gbk' | 'big5' | 'gb18030' | 'unicode'>('utf8');
  const [codecFormat, setCodecFormat] = useState<'hex' | 'unicode' | 'base64'>('hex');
  const imgBase64Ref = useRef<HTMLInputElement>(null);
  // P2-1: 用 ref 持有 interval，组件卸载时清理
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (intervalRef.current) clearInterval(intervalRef.current); }, []);

  const filteredOptions = activeCategory === 'all'
    ? convertOptions
    : convertOptions.filter(o => catOf(o) === activeCategory);

  // 点击选项 → 进入对应转换流程（所有卡片统一走 selected 流程页）
  const handleSelect = (o: ConvertOption) => {
    setSelected(o);
    setFiles([]);
    setTargetFormat(o.to[0] || '');
    setResult(null);
    setError(null);
    setDownloads([]);
    setQuality(80);
    setWidth('');
    setHeight('');
    setUtilityInput('');
    setEncodeInput('');
    setEncodeOutput('');
    setEncodeError(null);
    setCodecFormat('hex');
    setEncodeDirection('encode');
    setActiveCategory('all');
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setFiles(Array.from(e.target.files));
      setResult(null);
      setError(null);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files) {
      setFiles(Array.from(e.dataTransfer.files));
      setResult(null);
      setError(null);
    }
  };

  const handleConvert = async () => {
    if (!selected) return;
    if (selected.kind === 'encode') {
      // 编码转换：纯前端处理
      if (!encodeInput && selected.op !== 'image-to-base64') { setEncodeError('请输入内容'); return; }
      setEncodeError(null);
      try {
        if (selected.op === 'to-utf8') {
          // 双向编码互转：encode（文字→编码）/ decode（编码→文字）
          // UTF-8 / Unicode 前端处理；GBK/Big5/gb18030 走后端 iconv
          const input = encodeInput;
          const enc = encodeEncoding;
          const fmt = codecFormat;

          // GBK/Big5/gb18030 走后端
          if (enc === 'gbk' || enc === 'big5' || enc === 'gb18030') {
            const res = await fetch('/api/toolbox/encode', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ op: encodeDirection === 'encode' ? 'encode-text' : 'decode-text', input, encoding: enc, format: fmt }),
            });
            const data = await res.json();
            if (!res.ok) { setEncodeError(data?.error?.message || data?.error || '转换失败'); return; }
            setEncodeOutput(data.result);
            return;
          }

          if (encodeDirection === 'encode') {
            // 文字 → 编码
            // Unicode 转义（\u4f60\u597d）
            let unicodeOut = '';
            for (const ch of input) {
              const code = ch.codePointAt(0)!;
              if (code > 0xFFFF) {
                const hi = Math.floor((code - 0x10000) / 0x400) + 0xD800;
                const lo = ((code - 0x10000) % 0x400) + 0xDC00;
                unicodeOut += `\\u${hi.toString(16).padStart(4, '0')}\\u${lo.toString(16).padStart(4, '0')}`;
              } else if (code > 0x7F || ch === '\\') {
                unicodeOut += `\\u${code.toString(16).padStart(4, '0')}`;
              } else {
                unicodeOut += ch;
              }
            }
            // UTF-8 十六进制字节
            const utf8Bytes = new TextEncoder().encode(input);
            const hexOut = Array.from(utf8Bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
            const hexCompact = hexOut.replace(/ /g, '');
            const b64 = btoa(unescape(encodeURIComponent(input)));

            if (fmt === 'unicode') setEncodeOutput(unicodeOut);
            else if (fmt === 'hex') setEncodeOutput(`${hexCompact}\n[带空格] ${hexOut}`);
            else if (fmt === 'base64') setEncodeOutput(b64);
            else setEncodeOutput(`${unicodeOut}\n\n[UTF-8 十六进制] ${hexCompact}\n[带空格] ${hexOut}\n[Base64] ${b64}`);
          } else {
            // 编码 → 文字
            const trimmed = input.trim();
            if (fmt === 'unicode') {
              // \uXXXX 转义解码
              const decoded = trimmed.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
              setEncodeOutput(decoded);
            } else if (fmt === 'base64') {
              try {
                setEncodeOutput(decodeURIComponent(escape(atob(trimmed))));
              } catch { setEncodeError('Base64 内容无效'); }
            } else {
              // hex 解码
              const clean = trimmed.replace(/\\x/g, '').replace(/[^0-9a-fA-F]/g, '');
              if (clean.length % 2 !== 0) { setEncodeError('十六进制长度必须为偶数'); return; }
              const bytes = new Uint8Array(clean.match(/.{2}/g)!.map(b => parseInt(b, 16)));
              setEncodeOutput(new TextDecoder().decode(bytes));
            }
          }
        } else if (selected.op === 'base64') {
          const isB64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encodeInput.trim()) && encodeInput.length % 4 === 0;
          if (isB64) {
            setEncodeOutput(decodeURIComponent(escape(atob(encodeInput.trim()))));
          } else {
            setEncodeOutput(btoa(unescape(encodeURIComponent(encodeInput))));
          }
        }
      } catch (e: unknown) {
        setEncodeError('转换失败: ' + (e instanceof Error ? e.message : String(e)));
      }
      return;
    }
    // youtube-download 无需文件（输入 URL）；其余工具需文件
    if (selected.kind !== 'utility' && selected.kind !== 'youtube-download' && files.length === 0) return;
    if (selected.kind === 'utility' && !utilityInput) { setError('请输入内容'); return; }
    if (selected.kind === 'youtube-download' && !utilityInput.trim()) { setError('请输入视频 URL'); return; }
    if (selected.kind === 'convert' && !targetFormat) return;
    setConverting(true);
    setProgress(0);
    setError(null);
    setResult(null);

    // 徒有其表修复：不再用假进度条（每秒+1%到90%卡住）。
    // 改为诚实显示已等待秒数，进度条仅两态：处理中(不确定动画)/完成。
    setElapsedSec(0);
    intervalRef.current = setInterval(() => {
      setElapsedSec(s => s + 1);
    }, 1000);

    try {
      // utility: 直接调小工具 API
      if (selected.kind === 'utility') {
        const opMap: Record<string, string> = {
          base64: /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(utilityInput.trim()) ? 'base64-decode' : 'base64-encode',
          timestamp: /^\d{10}$/.test(utilityInput.trim()) ? 'timestamp-to-date' : 'date-to-timestamp',
          color: utilityInput.trim().startsWith('#') ? 'hex-rgb' : 'rgb-hex',
        };
        const r = await fetch('/api/toolbox/utility', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ op: opMap[selected.op || ''] || 'base64-encode', input: utilityInput }),
        });
        const data = await r.json();
        clearInterval(intervalRef.current!); setProgress(100);
        if (data?.result) setResult(String(data.result));
        else setError(data?.error || '处理失败，请检查文件格式或稍后重试');
        setConverting(false);
        return;
      }
      const fileData = await Promise.all(files.map(f => new Promise<{ name: string; data: string }>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ name: f.name, data: reader.result as string });
        reader.onerror = () => reject(new Error('文件读取失败'));
        reader.readAsDataURL(f);
      })));

      let res: any;
      if (selected.kind === 'convert') {
        // 图片 → 图片：附带 quality 压缩 + width/height 缩放选项
        const isImageToImage = selected.from.every(f => ['png', 'jpg', 'jpeg', 'webp'].includes(f))
          && selected.to.every(f => ['png', 'jpg', 'jpeg', 'webp'].includes(f));
        const options: any = {};
        if (isImageToImage) {
          options.quality = quality;
          if (width) options.width = Number(width);
          if (height) options.height = Number(height);
        }
        res = await fetch('/api/toolbox/convert', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ files: fileData, targetFormat, options }),
        });
        res = await res.json();
        if (res?.results?.length > 0) {
          const successCount = res.results.filter((r: any) => r.success).length;
          setDownloads(res.results.filter((r: any) => r.output).map((r: any) => r.output));
          setResult(`转换完成！${successCount}/${res.results.length} 个文件成功`);
        } else if (res?.error) { setError(res.error); }
        else setResult('转换完成！');
      } else if (selected.kind === 'pdf-compress') {
        res = await fetch('/api/toolbox/pdf-compress', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ files: fileData }),
        });
        res = await res.json();
        if (res?.output) { setDownloads([res.output]); setResult(`压缩完成！${Math.round((1 - res.compressedSize / res.originalSize) * 100)}% 体积减小`); }
        else setError(res?.error || '压缩失败，请检查文件格式或稍后重试');
      } else if (selected.kind === 'unlock') {
        res = await fetch('/api/toolbox/unlock-music', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ file: fileData[0] }),
        });
        res = await res.json();
        if (res?.output) { setDownloads([res.output]); setResult(`解密完成！(格式: ${res.format || 'mp3'})`); }
        else setError(res?.error || '解密失败，请检查文件是否为有效的 ncm 格式');
      } else if (selected.kind === 'pdf-operate') {
        res = await fetch('/api/toolbox/pdf-operate', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ operation: selected.op, files: fileData, text: watermarkText }),
        });
        res = await res.json();
        if (res?.output) { setDownloads([res.output]); setResult('处理完成！'); }
        else setError(res?.error || 'PDF 处理失败，请检查文件是否为有效的 PDF 格式');
      } else if (selected.kind === 'pdf-read') {
        res = await fetch('/api/toolbox/pdf-read', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ op: selected.op, file: fileData[0] }),
        });
        res = await res.json();
        if (res?.output) { setDownloads([res.output]); setResult('处理完成！'); }
        else if (res?.result) { setResult(String(res.result).slice(0, 500)); }
        else setError(res?.error || 'PDF 读取失败，请检查文件是否为有效的 PDF 格式');
      } else if (selected.kind === 'pdf-to-docx') {
        res = await fetch('/api/toolbox/pdf-to-docx', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ file: fileData[0] }),
        });
        res = await res.json();
        if (res?.output) { setDownloads([res.output]); setResult(`转换完成！${res.pageCount ? `共 ${res.pageCount} 页` : ''}`); }
        else setError(res?.error || 'PDF → DOCX 转换失败，请检查文件是否为有效的 PDF 格式');
      } else if (selected.kind === 'video-extract') {
        // 视频提取音频（ffmpeg）
        res = await fetch('/api/toolbox/video-extract', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ files: fileData, targetFormat }),
        });
        res = await res.json();
        if (res?.results?.length > 0) {
          const ok = res.results.filter((r: any) => r.success);
          setDownloads(ok.map((r: any) => r.output));
          const failed = res.results.filter((r: any) => !r.success);
          if (ok.length > 0) setResult(`提取完成！${ok.length} 个成功${failed.length ? `，${failed.length} 个失败: ${failed[0].message || ''}` : ''}`);
          else setError(failed[0]?.message || '音频提取失败');
        } else setError(res?.error || '音频提取失败');
      } else if (selected.kind === 'youtube-download') {
        // YouTube 下载（yt-dlp）
        res = await fetch('/api/toolbox/youtube-download', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ url: utilityInput.trim(), format: targetFormat, quality }),
        });
        res = await res.json();
        if (res?.success && res?.output) {
          setDownloads([res.output]);
          setResult(`下载完成！${res.title || ''} (${res.format || ''})`);
        } else setError(res?.error || '下载失败，请检查 URL 或网络');
      }
      clearInterval(intervalRef.current!);
      setProgress(100);
      setFiles([]);
    } catch (e: unknown) {
      clearInterval(intervalRef.current!);
      setError((e instanceof Error ? e.message : String(e)) || '转换失败');
    }
    setConverting(false);
  };

  const handleBack = () => {
    setSelected(null);
    setResult(null);
    setError(null);
    setFiles([]);
  };

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)', backgroundImage: 'var(--bg-gradient)' }}>
      <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '0 24px' }}>
        <PageHeader title="工具箱" description="格式转换 · 文档处理 · 音频工具" icon={<Wrench size={22} />} color="var(--color-warning)" />

        {!selected ? (
          <ToolboxList
            activeCategory={activeCategory}
            setActiveCategory={setActiveCategory}
            onSelect={handleSelect}
          />
        ) : (
          <ToolboxProcess
            selected={selected}
            onBack={handleBack}
            onConvert={handleConvert}
            converting={converting}
            progress={progress}
            elapsedSec={elapsedSec}
            files={files}
            setFiles={setFiles}
            targetFormat={targetFormat}
            setTargetFormat={setTargetFormat}
            watermarkText={watermarkText}
            setWatermarkText={setWatermarkText}
            quality={quality}
            setQuality={setQuality}
            width={width}
            setWidth={setWidth}
            height={height}
            setHeight={setHeight}
            result={result}
            downloads={downloads}
            error={error}
            fileInputRef={fileInputRef}
            handleDrop={handleDrop}
            handleFileSelect={handleFileSelect}
            encodeInput={encodeInput}
            setEncodeInput={setEncodeInput}
            encodeOutput={encodeOutput}
            setEncodeOutput={setEncodeOutput}
            encodeError={encodeError}
            setEncodeError={setEncodeError}
            encodeDirection={encodeDirection}
            setEncodeDirection={setEncodeDirection}
            encodeEncoding={encodeEncoding}
            setEncodeEncoding={setEncodeEncoding}
            codecFormat={codecFormat}
            setCodecFormat={setCodecFormat}
            utilityInput={utilityInput}
            setUtilityInput={setUtilityInput}
            imgBase64Ref={imgBase64Ref}
          />
        )}
      </div>
    </div>
  );
}