import { motion } from 'framer-motion';
import { Wrench, X, Upload, Download, Binary, Loader2, CheckCircle2, AlertCircle, Sliders, Music, FileImage } from 'lucide-react';
import type { ConvertOption } from './types';
import { EncodeTools } from './EncodeTools';
import { UtilityTools } from './UtilityTools';
import { FileTools } from './FileTools';

interface ToolboxProcessProps {
  selected: ConvertOption;
  onBack: () => void;
  onConvert: () => void;
  converting: boolean;
  progress: number;
  files: File[];
  setFiles: (files: File[]) => void;
  targetFormat: string;
  setTargetFormat: (v: string) => void;
  watermarkText: string;
  setWatermarkText: (v: string) => void;
  quality: number;
  setQuality: (v: number) => void;
  width: string;
  setWidth: (v: string) => void;
  height: string;
  setHeight: (v: string) => void;
  result: string | null;
  downloads: string[];
  error: string | null;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  handleDrop: (e: React.DragEvent) => void;
  handleFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
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
  utilityInput: string;
  setUtilityInput: (v: string) => void;
  imgBase64Ref: React.RefObject<HTMLInputElement | null>;
}

export function ToolboxProcess({
  selected, onBack, onConvert, converting, progress,
  files, setFiles, targetFormat, setTargetFormat,
  watermarkText, setWatermarkText,
  quality, setQuality, width, setWidth, height, setHeight,
  result, downloads, error,
  fileInputRef, handleDrop, handleFileSelect,
  encodeInput, setEncodeInput, encodeOutput, setEncodeOutput,
  encodeError, setEncodeError,
  encodeDirection, setEncodeDirection,
  encodeEncoding, setEncodeEncoding,
  codecFormat, setCodecFormat,
  utilityInput, setUtilityInput,
  imgBase64Ref
}: ToolboxProcessProps) {
  return (
    <motion.div className="glass-card" style={{ padding: 'var(--card-padding)' }} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center flex-shrink-0" style={{ width: 40, height: 40, borderRadius: 'var(--radius-md)', background: `${selected.color}18` }}>
            <span style={{ color: selected.color }}>{selected.icon}</span>
          </div>
          <div>
            <h2 style={{ fontSize: 'var(--font-card-title)', fontWeight: 600, color: 'var(--text-primary)' }}>{selected.label}</h2>
            <p style={{ fontSize: 'var(--font-xs)', color: 'var(--text-tertiary)', marginTop: 2 }}>{selected.hint}</p>
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onBack} style={{ fontSize: 13 }}>← 返回工具列表</button>
      </div>

      {selected.kind === 'encode' ? (
        <EncodeTools
          selected={selected}
          onBack={onBack}
          onConvert={onConvert}
          converting={converting}
          progress={progress}
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
          imgBase64Ref={imgBase64Ref}
        />
      ) : selected.kind === 'utility' ? (
        <UtilityTools
          selected={selected}
          onConvert={onConvert}
          converting={converting}
          utilityInput={utilityInput}
          setUtilityInput={setUtilityInput}
        />
      ) : (
        <FileTools
          selected={selected}
          onBack={onBack}
          onConvert={onConvert}
          converting={converting}
          progress={progress}
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
        />
      )}
    </motion.div>
  );
}