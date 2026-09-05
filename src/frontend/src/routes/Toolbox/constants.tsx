import { FileImage, FileText, Sheet, File, AudioLines, Disc3, Palette as PaletteIcon, Shrink, FileDown, Sliders, Music, Binary, Type, Upload, Download, X, Video, Youtube } from 'lucide-react';
import type { ConvertOption, ToolCategory } from './types';

export const convertOptions: ConvertOption[] = [
  { kind: 'convert', from: ['png', 'jpg', 'jpeg', 'webp'], to: ['pdf'], label: '图片 → PDF', desc: '多张图片合并为一个 PDF', icon: <FileImage size={20} />, color: 'var(--color-accent)', hint: '选择图片文件，自动合并为 PDF' },
  { kind: 'convert', from: ['docx'], to: ['pdf'], label: 'DOCX → PDF', desc: 'Word 文档转 PDF（LibreOffice）', icon: <FileText size={20} />, color: 'var(--color-success)', hint: '选择 .docx 文件' },
  { kind: 'convert', from: ['xlsx'], to: ['pdf'], label: 'Excel → PDF', desc: 'Excel 表格转 PDF（LibreOffice）', icon: <Sheet size={20} />, color: 'var(--color-warning)', hint: '选择 .xlsx 文件' },
  { kind: 'convert', from: ['xlsx'], to: ['csv'], label: 'Excel → CSV', desc: 'Excel 表格转 CSV', icon: <Sheet size={20} />, color: '#a78bfa', hint: '选择 .xlsx 文件' },
  { kind: 'convert', from: ['csv'], to: ['xlsx'], label: 'CSV → Excel', desc: 'CSV 转 Excel 表格', icon: <File size={20} />, color: '#60a5fa', hint: '选择 .csv 文件' },
  { kind: 'pdf-operate', op: 'merge', from: ['pdf'], to: ['pdf'], label: 'PDF 合并', desc: 'pdf-lib 合并多个 PDF', icon: <FileText size={20} />, color: 'var(--color-success)', hint: '选择多个 PDF 文件合并为一个' },
  { kind: 'pdf-operate', op: 'watermark', from: ['pdf'], to: ['pdf'], label: 'PDF 加水印', desc: '给 PDF 添加文字水印', icon: <FileText size={20} />, color: 'var(--color-warning)', hint: '选一个 PDF，输入水印文字' },
  { kind: 'pdf-read', op: 'to-image', from: ['pdf'], to: ['png'], label: 'PDF → 图片', desc: '渲染 PDF 首页为图片', icon: <FileImage size={20} />, color: '#a78bfa', hint: '选一个 PDF，渲染为 PNG 图片' },
  { kind: 'pdf-read', op: 'to-text', from: ['pdf'], to: ['txt'], label: 'PDF 文字提取', desc: '提取 PDF 全部文字', icon: <FileText size={20} />, color: '#60a5fa', hint: '选一个 PDF，提取全文文字' },
  { kind: 'pdf-compress', from: ['pdf'], to: ['pdf'], label: 'PDF 压缩', desc: '压缩 PDF 文件体积', icon: <FileText size={20} />, color: 'var(--color-danger)', hint: '选一个 PDF 文件压缩' },
  { kind: 'pdf-to-docx', from: ['pdf'], to: ['docx'], label: 'PDF → DOCX', desc: 'PDF 转 Word 文档（提取文本）', icon: <FileDown size={20} />, color: 'var(--color-accent)', hint: '选一个 PDF，转换为 Word 文档' },
  { kind: 'convert', from: ['png', 'jpg', 'jpeg', 'webp'], to: ['png', 'jpg', 'jpeg', 'webp'], label: '图片格式转换', desc: 'png/jpg/webp 互转（可压缩/缩放）', icon: <FileImage size={20} />, color: 'var(--color-danger)', hint: '选择图片，选择目标格式' },
  { kind: 'convert', from: ['png', 'jpg', 'jpeg', 'webp'], to: ['webp'], label: '图片压缩', desc: '压缩为 webp（体积更小）', icon: <Shrink size={20} />, color: 'var(--color-warning)', hint: '选择图片，压缩为 webp' },
  { kind: 'convert', from: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'], to: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'], label: '音频转换', desc: '音频格式互转（ffmpeg）', icon: <AudioLines size={20} />, color: 'var(--color-success)', hint: '选择音频文件，选择目标格式' },
  { kind: 'unlock', op: 'ncm', from: ['ncm', 'qmc', 'kgm'], to: ['mp3', 'flac'], label: '音乐解锁', desc: '解密加密音乐（ncm / qmc / kgm）', icon: <Disc3 size={20} />, color: '#a78bfa', hint: '选择 .ncm / .qmc / .kgm 文件，自动解密为音频' },
  { kind: 'utility', op: 'base64', from: [], to: [], label: 'Base64 编解码', desc: '文本与 Base64 互转', icon: <File size={20} />, color: 'var(--color-accent)', hint: '输入文本或 Base64 内容' },
  { kind: 'utility', op: 'timestamp', from: [], to: [], label: '时间戳转换', desc: 'Unix 时间戳 ↔ 日期', icon: <FileText size={20} />, color: 'var(--color-warning)', hint: '输入时间戳或日期' },
  { kind: 'utility', op: 'color', from: [], to: [], label: '颜色转换', desc: 'HEX ↔ RGB', icon: <PaletteIcon size={20} />, color: '#a78bfa', hint: '输入 hex 颜色或 rgb 颜色' },
  { kind: 'encode', op: 'to-utf8', from: [], to: [], label: '编码互转', desc: '文字 ↔ 编码双向转换（UTF-8/GBK/Unicode/Base64）', icon: <Type size={20} />, color: 'var(--color-warning)', hint: '文字转编码 或 编码转文字（支持 UTF-8/GBK/Big5 等）' },
  { kind: 'encode', op: 'image-to-base64', from: [], to: [], label: '图片转 Base64', desc: '图片转 Data URL', icon: <FileImage size={20} />, color: '#a78bfa', hint: '选择图片自动转换' },
  { kind: 'video-extract', from: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'wmv'], to: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg'], label: '视频提取音频', desc: '从视频中提取音频（ffmpeg）', icon: <Video size={20} />, color: '#f472b6', hint: '选择视频文件，提取为音频' },
  { kind: 'youtube-download', from: ['url'], to: ['mp4', 'webm', 'mp3', 'm4a', 'wav', 'flac'], label: 'YouTube 下载', desc: '下载 YouTube 视频/音频（yt-dlp）', icon: <Youtube size={20} />, color: '#ef4444', hint: '粘贴视频链接，选择格式下载' },
];

export const categories: ToolCategory[] = [
  { id: 'all', label: '全部', color: 'var(--color-accent)' },
  { id: 'document', label: '文档', color: 'var(--color-success)' },
  { id: 'image', label: '图片', color: 'var(--color-warning)' },
  { id: 'audio', label: '音频', color: '#a78bfa' },
  { id: 'video', label: '视频', color: '#f472b6' },
  { id: 'encode', label: '编码', color: 'var(--color-accent)' },
];

export const catOf = (o: ConvertOption): string => {
  if (o.kind === 'encode') return 'encode';
  if (o.kind === 'video-extract' || o.kind === 'youtube-download') return 'video';
  if (o.from[0] === 'png' || o.from[0] === 'jpg') return 'image';
  if (o.from[0] === 'mp3' || o.from[0] === 'ncm') return 'audio';
  return 'document';
};