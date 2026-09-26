import { useState, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import { PageHeader } from '../components/PageHeader';
import { Wrench, Upload, Download, Loader2, CheckCircle2, AlertCircle, X } from 'lucide-react';
import type { ConvertOption } from './Toolbox/types';
import { ToolboxList } from './Toolbox/ToolboxList';
import { ToolboxProcess } from './Toolbox/ToolboxProcess';
import { convertOptions, categories, catOf } from './Toolbox/constants';
import { api } from '../api/client';
import type { ToolAvailability } from '../api/types';

/**
 * P1-6/P1-Oracle 修复（审计）：Base64 判定不再"只看格式+长度%4"，增加：
 * 1. 严格格式 + 长度 %4==0（含 padding）
 * 2. 可解码性：atob 必须成功
 * 3. 可读性启发式：解码结果是可打印文本 → 判定为 Base64（decode）
 * 4. 二进制兜底：解码结果不可打印但输入含 Base64 特有字符（+ / =）或较长（>=16）→
 *    也是真 Base64（如图片/压缩包等二进制内容），判定 decode，避免误判为普通文本
 * 这样"test"（短、无 +/=）→ encode；"iVBORw0KGgo..."（长、含+/）→ decode
 */
export function looksLikeBase64(input: string): boolean {
  const s = (input || '').trim();
  if (!s) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)) return false;
  if (s.length % 4 !== 0) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(escape(atob(s)));
  } catch {
    // 无法解码 → 不是 Base64（是待编码文本）
    return false;
  }
  if (!decoded) return true;
  // 可打印字符占比 > 70% → 可解码的 Base64 文本
  const printable = (decoded.match(/[\x20-\x7E\n\r\t]/g) || []).length;
  if (printable / decoded.length > 0.7) return true;
  // 解码为二进制（不可打印）但输入具有 Base64 特征 → 也是真 Base64（如图片/压缩）
  if (s.includes('+') || s.includes('/') || s.endsWith('=') || s.length >= 16) return true;
  return false;
}

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

  // 外部工具检测：ffmpeg / yt-dlp / LibreOffice（缺失时提示下载）
  // AEX-P1-017：区分 loading / success / error —— 原先 `catch { 静默 }` 让"后端没启动"
  // 与"工具齐全"呈现同一个界面，用户无从判断该不该装依赖。
  const [toolsStatus, setToolsStatus] = useState<Record<string, ToolAvailability> | null>(null);
  const [toolsStatusError, setToolsStatusError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await api.result.getToolsStatus();
      if (cancelled) return;
      if (res.ok) { setToolsStatus(res.data); setToolsStatusError(null); }
      else { setToolsStatus(null); setToolsStatusError(res.error.message); }
    })();
    return () => { cancelled = true; };
  }, []);

  // 当前工具所需的外部工具（缺失时显示提示卡）
  const requiredTool = selected?.kind === 'video-extract' ? 'ffmpeg'
    : selected?.kind === 'youtube-download' ? 'ytDlp'
    : (selected?.kind === 'convert' && (selected.from[0] === 'mp3' || selected.from[0] === 'wav' || selected.from[0] === 'flac' || selected.from[0] === 'ogg' || selected.from[0] === 'm4a' || selected.from[0] === 'aac')) ? 'ffmpeg'
    : (selected?.kind === 'convert' && (selected.from[0] === 'docx' || selected.from[0] === 'xlsx') && selected.to[0] === 'pdf') ? 'libreOffice'
    : null;
  const missingTool = requiredTool && toolsStatus ? toolsStatus[requiredTool] : null;
  const toolMissing = !!missingTool && missingTool.available === false;

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

          // GBK/Big5/gb18030 走后端（AEX-P1-017：经 api.result，错误为结构化 ApiError）
          if (enc === 'gbk' || enc === 'big5' || enc === 'gb18030') {
            const res = await api.result.encode({
              op: encodeDirection === 'encode' ? 'encode-text' : 'decode-text',
              input, encoding: enc, format: fmt,
            });
            if (!res.ok) { setEncodeError(res.error.message); return; }
            if (res.data.error) { setEncodeError(res.data.error); return; }
            setEncodeOutput(res.data.result ?? '');
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
          const isB64 = looksLikeBase64(encodeInput);
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
          base64: looksLikeBase64(utilityInput) ? 'base64-decode' : 'base64-encode',
          // P1-6 修复（审计）：同时识别 10 位秒级与 13 位毫秒级时间戳
          timestamp: /^\d{10}$|^\d{13}$/.test(utilityInput.trim()) ? 'timestamp-to-date' : 'date-to-timestamp',
          color: utilityInput.trim().startsWith('#') ? 'hex-rgb' : 'rgb-hex',
        };
        const r = await api.result.utility({ op: opMap[selected.op || ''] || 'base64-encode', input: utilityInput });
        clearInterval(intervalRef.current!); setProgress(100);
        // AEX-P1-017：区分"接口失败"（ApiError）与"接口成功但无结果"（业务错误文案）
        if (!r.ok) setError(r.error.message);
        else if (r.data.result) setResult(String(r.data.result));
        else setError(r.data.error || '处理失败，请检查文件格式或稍后重试');
        setConverting(false);
        return;
      }
      // P1-10 修复（审计 #23）：大文件全部 readAsDataURL + Promise.all 并行读入内存会造成
      // 内存峰值（Base64 膨胀 +33%）。改为**串行逐个读取**，避免多文件同时驻留内存；
      // 并对超大文件（>50MB）拒绝，提示改用更小文件。
      const fileData: Array<{ name: string; data: string }> = [];
      for (const f of files) {
        if (f.size > 50 * 1024 * 1024) {
          clearInterval(intervalRef.current!);
          setProgress(0);
          setConverting(false);
          setError(`文件过大（${(f.size / 1024 / 1024).toFixed(1)}MB）：为避免内存溢出，请使用 50MB 以内的文件`);
          return;
        }
        const item = await new Promise<{ name: string; data: string }>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve({ name: f.name, data: reader.result as string });
          reader.onerror = () => reject(new Error('文件读取失败'));
          reader.readAsDataURL(f);
        });
        fileData.push(item);
      }

      // AEX-P1-017：所有工具箱端点统一经 api.result（ApiResult 契约）。
      // finish() 收敛收尾动作（停秒表 / 进度 100 / 落结果或错误 / 清空已消费文件），
      // 消除原先 7 个分支各自复制收尾代码的漂移风险。
      const finish = (o: { downloads?: string[]; result?: string; error?: string }) => {
        clearInterval(intervalRef.current!);
        setProgress(100);
        setFiles([]);
        if (o.downloads) setDownloads(o.downloads);
        if (o.result !== undefined) setResult(o.result);
        if (o.error) setError(o.error);
      };
      /** 接口级失败（网络/非 2xx/解析失败）—— 统一收尾并结束 loading 态 */
      const fail = (message: string) => {
        clearInterval(intervalRef.current!);
        setProgress(100);
        setFiles([]);
        setError(message);
        setConverting(false);
      };

      if (selected.kind === 'convert') {
        // 图片 → 图片：附带 quality 压缩 + width/height 缩放选项
        const isImageToImage = selected.from.every(f => ['png', 'jpg', 'jpeg', 'webp'].includes(f))
          && selected.to.every(f => ['png', 'jpg', 'jpeg', 'webp'].includes(f));
        const options: Record<string, unknown> = {};
        if (isImageToImage) {
          options.quality = quality;
          if (width) options.width = Number(width);
          if (height) options.height = Number(height);
        }
        const r = await api.result.convert({ files: fileData, targetFormat, options });
        if (!r.ok) { fail(r.error.message); return; }
        const items = r.data.results ?? [];
        if (items.length > 0) {
          const successCount = items.filter(i => i.success).length;
          finish({
            downloads: items.flatMap(i => (i.output ? [i.output] : [])),
            result: `转换完成！${successCount}/${items.length} 个文件成功`,
          });
        } else if (r.data.error) finish({ error: r.data.error });
        else finish({ result: '转换完成！' });
      } else if (selected.kind === 'pdf-compress') {
        const r = await api.result.pdfCompress(fileData);
        if (!r.ok) { fail(r.error.message); return; }
        const { output, compressedSize, originalSize, error } = r.data;
        if (output) {
          const savedPct = compressedSize !== undefined && originalSize
            ? Math.round((1 - compressedSize / originalSize) * 100) : 0;
          finish({ downloads: [output], result: `压缩完成！${savedPct}% 体积减小` });
        } else finish({ error: error || '压缩失败，请检查文件格式或稍后重试' });
      } else if (selected.kind === 'unlock') {
        const r = await api.result.unlockMusic(fileData[0]);
        if (!r.ok) { fail(r.error.message); return; }
        const { output, format, error } = r.data;
        if (output) finish({ downloads: [output], result: `解密完成！(格式: ${format || 'mp3'})` });
        else finish({ error: error || '解密失败，请检查文件是否为有效的 ncm 格式' });
      } else if (selected.kind === 'pdf-operate') {
        const r = await api.result.pdfOperate({ operation: selected.op, files: fileData, text: watermarkText });
        if (!r.ok) { fail(r.error.message); return; }
        if (r.data.output) finish({ downloads: [r.data.output], result: '处理完成！' });
        else finish({ error: r.data.error || 'PDF 处理失败，请检查文件是否为有效的 PDF 格式' });
      } else if (selected.kind === 'pdf-read') {
        const r = await api.result.pdfRead({ op: selected.op, file: fileData[0] });
        if (!r.ok) { fail(r.error.message); return; }
        const { output, result: text, error } = r.data;
        if (output) finish({ downloads: [output], result: '处理完成！' });
        else if (text) finish({ result: String(text).slice(0, 500) });
        else finish({ error: error || 'PDF 读取失败，请检查文件是否为有效的 PDF 格式' });
      } else if (selected.kind === 'pdf-to-docx') {
        const r = await api.result.pdfToDocx(fileData[0]);
        if (!r.ok) { fail(r.error.message); return; }
        const { output, pageCount, error } = r.data;
        if (output) finish({ downloads: [output], result: `转换完成！${pageCount ? `共 ${pageCount} 页` : ''}` });
        else finish({ error: error || 'PDF → DOCX 转换失败，请检查文件是否为有效的 PDF 格式' });
      } else if (selected.kind === 'video-extract') {
        // 视频提取音频（ffmpeg）
        const r = await api.result.videoExtract({ files: fileData, targetFormat });
        if (!r.ok) { fail(r.error.message); return; }
        const items = r.data.results ?? [];
        if (items.length > 0) {
          const ok = items.filter(i => i.success);
          const failed = items.filter(i => !i.success);
          if (ok.length > 0) {
            finish({
              downloads: ok.flatMap(i => (i.output ? [i.output] : [])),
              result: `提取完成！${ok.length} 个成功${failed.length ? `，${failed.length} 个失败: ${failed[0].message || ''}` : ''}`,
            });
          } else finish({ error: failed[0]?.message || '音频提取失败' });
        } else finish({ error: r.data.error || '音频提取失败' });
      } else if (selected.kind === 'youtube-download') {
        // YouTube 下载（yt-dlp）
        const r = await api.result.youtubeDownload({ url: utilityInput.trim(), format: targetFormat, quality });
        if (!r.ok) { fail(r.error.message); return; }
        const { success, output, title, format, error } = r.data;
        if (success && output) finish({ downloads: [output], result: `下载完成！${title || ''} (${format || ''})` });
        else finish({ error: error || '下载失败，请检查 URL 或网络' });
      } else {
        clearInterval(intervalRef.current!);
        setProgress(100);
        setFiles([]);
      }
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

        {/* AEX-P1-017：依赖探测失败必须显式告知 —— 否则用户选了"视频提取音频"失败时
            无从判断是缺 ffmpeg 还是后端没起来（原先 catch 静默，界面与"依赖齐全"完全一致）。 */}
        {toolsStatusError && (
          <div className="glass-card" style={{ padding: '10px 14px', marginBottom: 16, fontSize: 13, color: 'var(--color-warning)' }}>
            ⚠️ 外部依赖检测失败：{toolsStatusError}（ffmpeg / yt-dlp / LibreOffice 缺失时相关工具将无法使用）
          </div>
        )}

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
            toolMissing={toolMissing}
            missingToolInfo={missingTool}
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