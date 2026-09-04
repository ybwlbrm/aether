import { useState, useRef } from 'react';
import { motion } from 'framer-motion';
import { Paperclip, Image, Mic, Send } from 'lucide-react';

interface AIAgentInputProps {
  onSend: (message: string) => void;
  isProcessing?: boolean;
}

export function AIAgentInput({ onSend, isProcessing }: AIAgentInputProps) {
  const [input, setInput] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const handleFileClick = () => fileInputRef.current?.click();
  const handleImageClick = () => imageInputRef.current?.click();
  const handleMicClick = () => {
    if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
      onSend('[语音输入] 麦克风已就绪，请说话...');
    } else {
      onSend('[语音输入] 当前浏览器不支持麦克风');
    }
  };
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      onSend(`已选择文件: ${files.map(f => f.name).join(', ')}`);
    }
    e.target.value = '';
  };

  const handleSend = () => {
    if (!input.trim() || isProcessing) return;
    onSend(input.trim());
    setInput('');
  };
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as any).isComposing) { e.preventDefault(); handleSend(); }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.25, 0.1, 0.25, 1] }}
      onDragOver={e => { e.preventDefault(); setIsDragOver(true); }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={e => { e.preventDefault(); setIsDragOver(false); const files = Array.from(e.dataTransfer.files); if (files.length > 0) onSend(`处理文件: ${files.map(f => f.name).join(', ')}`); }}
    >
      {/* Title: 36px, center, line-height 1.2, top 60px */}
      <div className="text-center" style={{ paddingTop: '60px' }}>
        <h1 style={{ fontSize: '36px', fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.2, color: 'var(--text-primary)', textAlign: 'center' }}>
          今天需要我帮你完成什么？
        </h1>
        <p style={{ fontSize: '15px', color: '#94a3b8', marginTop: '16px', fontWeight: 400, lineHeight: 1.5, textAlign: 'center' }}>
          让 AI 处理文件、生成内容、分析数据、管理项目
        </p>
      </div>

      {/* Hidden file inputs */}
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileChange} />
      <input ref={imageInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFileChange} />

      {/* Input: 140px, 12px radius, 24px padding, centered */}
      <div className="mx-auto" style={{ maxWidth: '900px', marginTop: '32px', marginBottom: '32px' }}>
        <div className="glass-card" style={{ borderRadius: '12px', border: '1px solid var(--input-border)', overflow: 'hidden', minHeight: '140px' }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onFocus={() => {}}
            onKeyDown={handleKeyDown}
            placeholder="描述你想要完成的任务..."
            className="w-full resize-none bg-transparent border-none outline-none"
            style={{ padding: '24px 24px 12px', minHeight: '80px', fontSize: '14px', lineHeight: 1.6, color: 'var(--text-primary)', fontFamily: 'inherit' }}
          />
          <div className="flex items-center justify-between" style={{ padding: '0 24px 20px', minHeight: '48px' }}>
            <div className="flex items-center gap-5">
              <button className="w-8 h-8 flex items-center justify-center hover:bg-[var(--bg-surface)] transition-colors rounded-full" style={{ color: 'var(--text-tertiary)' }} onClick={handleFileClick} title="上传文件">
                  <Paperclip size={20} />
                </button>
                <button className="w-8 h-8 flex items-center justify-center hover:bg-[var(--bg-surface)] transition-colors rounded-full" style={{ color: 'var(--text-tertiary)' }} onClick={handleImageClick} title="上传图片">
                  <Image size={20} />
                </button>
                <button className="w-8 h-8 flex items-center justify-center hover:bg-[var(--bg-surface)] transition-colors rounded-full" style={{ color: 'var(--text-tertiary)' }} onClick={handleMicClick} title="语音输入">
                  <Mic size={20} />
                </button>
            </div>
            <div className="flex items-center gap-3">
              <span style={{ fontSize: '12px', fontWeight: 400, color: 'var(--text-tertiary)' }}>{isProcessing ? '处理中...' : 'Enter 发送'}</span>
              <motion.button
                onClick={handleSend}
                disabled={!input.trim() || isProcessing}
                className="flex items-center justify-center transition-all duration-200"
                style={{ width: '40px', height: '40px', borderRadius: '50%', background: input.trim() ? 'var(--color-accent)' : 'var(--bg-surface)', color: input.trim() ? 'var(--text-primary)' : 'var(--text-tertiary)', boxShadow: input.trim() ? '0 4px 12px rgba(59,130,246,0.3)' : 'none' }}
                whileHover={input.trim() ? { scale: 1.05 } : {}}
                whileTap={input.trim() ? { scale: 0.95 } : {}}
              >
                {isProcessing ? <div className="spinner spinner-sm" style={{ borderTopColor: 'var(--text-inverse)' }} /> : <Send size={18} />}
              </motion.button>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}