import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { writeFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, readdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { exportDir } from './utils.js';
import { isSafeFetchUrl, parseIpv4, isLinkLocal, isPrivateOrLoopback, isMetadataHostname } from '../../lib/safe-fetch.js';
import { assertMagicMatches } from '../../lib/magic-bytes.js';

// ESM 兼容：项目为 "type": "module"，无 __dirname 全局变量
const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// 视频工具：视频提取音频 + YouTube/通用视频下载
// ============================================================

// ffmpeg 路径：优先内置 build/ffmpeg.exe（随包分发），其次环境变量，最后系统 PATH
function resolveFfmpegPath(): string | null {
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  const candidates = [
    resolve(__dirname, '../../../build/ffmpeg.exe'),
    resolve(process.cwd(), 'build/ffmpeg.exe'),
    // EXE 打包版：bundle 位于 resources/app/build，工具随包同目录分发
    resolve(__dirname, 'ffmpeg.exe'),
    resolve(__dirname, '../ffmpeg.exe'),
    resolve(dirname(__dirname), 'ffmpeg.exe'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  try {
     
    const staticPath = require('ffmpeg-static');
    if (typeof staticPath === 'string' && existsSync(staticPath)) return staticPath;
  } catch { /* ffmpeg-static 未安装，回退系统 PATH */ }
  return 'ffmpeg'; // 让 execFile 搜索 PATH
}

// yt-dlp 路径：优先 build/yt-dlp.exe（随包分发），其次环境变量，最后系统 PATH
function resolveYtDlpPath(): string {
  if (process.env.YT_DLP_PATH && existsSync(process.env.YT_DLP_PATH)) return process.env.YT_DLP_PATH;
  // 打包版：resources/app/build/yt-dlp.exe；开发版：项目根 build/yt-dlp.exe
  const candidates = [
    resolve(__dirname, '../../../build/yt-dlp.exe'),
    resolve(process.cwd(), 'build/yt-dlp.exe'),
    // EXE 打包版：bundle 同目录
    resolve(__dirname, 'yt-dlp.exe'),
    resolve(__dirname, '../yt-dlp.exe'),
    resolve(dirname(__dirname), 'yt-dlp.exe'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return 'yt-dlp'; // 回退系统 PATH
}

/** 真实探测工具可用性：绝对路径直接检查文件；裸命令名通过 where/which 搜索 PATH */
function isToolAvailable(p: string | null): boolean {
  if (!p) return false;
  if (p.includes('\\') || p.includes('/')) return existsSync(p);
  try {
    const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
    const r = spawnSync(cmd, [p], { shell: false, encoding: 'utf8' });
    return r.status === 0 && (r.stdout || '').length > 0;
  } catch {
    return false;
  }
}

const VIDEO_EXTS = new Set(['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'wmv', 'm4v', 'ts', 'mts']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma']);

/** 从视频中提取音频（ffmpeg -vn） */
export function extractAudioFromVideo(input: Buffer, videoExt: string, target: string): Promise<Buffer> {
  return new Promise((resolveP, rejectP) => {
    const ffmpeg = resolveFfmpegPath();
    if (!ffmpeg) { rejectP(new Error('未找到 ffmpeg，请安装或设置 FFMPEG_PATH')); return; }
    const tmpIn = `${randomUUID()}.${videoExt}`;
    const tmpOut = `${randomUUID()}.${target}`;
    const inPath = resolve(process.env.TEMP || '.', tmpIn);
    const outPath = resolve(process.env.TEMP || '.', tmpOut);
    writeFileSync(inPath, input);

    const cleanup = () => {
      try { if (existsSync(inPath)) unlinkSync(inPath); } catch (_e: unknown) { /* ignore - intentional */ }
      try { if (existsSync(outPath)) unlinkSync(outPath); } catch (_e: unknown) { /* ignore - intentional */ }
    };

    // 先尝试流拷贝；失败则回退重编码（兼容 mkv/mov 容器）
    execFile(ffmpeg, ['-y', '-i', inPath, '-vn', '-c:a', 'copy', outPath], { timeout: 180000 }, (err) => {
      const tryFallback = () => {
        execFile(ffmpeg, ['-y', '-i', inPath, '-vn', '-c:a', 'aac', '-b:a', '192k', outPath], { timeout: 300000 }, (err2) => {
          try {
            if (err2) { rejectP(new Error(`音频提取失败: ${err2.message}`)); return; }
            if (!existsSync(outPath)) { rejectP(new Error('ffmpeg 无输出文件')); return; }
            resolveP(readFileSync(outPath));
          } catch (e) { rejectP(e); }
          finally { cleanup(); }
        });
      };
      try {
        if (err) { tryFallback(); return; }
        if (!existsSync(outPath) || readFileSync(outPath).length === 0) { tryFallback(); return; }
        resolveP(readFileSync(outPath));
      } catch (e) { rejectP(e); }
      finally {
        if (!err) cleanup();
      }
    });
  });
}

/**
 * SEC-001: yt-dlp 下载 URL 必须为公网地址（SSRF 收紧校验）
 *
 * 与普通 fetch（允许本地 AI Provider）不同，yt-dlp 是"拉取式"下载器，
 * 若允许内网/回环地址，攻击者可借它访问后端自身 API（127.0.0.1:3000）、
 * 云元数据（169.254.169.254）与内网资源。因此此处必须拒绝所有非公网地址：
 * - 链路本地 169.254.0.0/16（含云元数据）
 * - 回环 127.0.0.0/8、::1、0.0.0.0
 * - 私网 10/8、172.16/12、192.168/16
 * - IPv6 字面量（::1 / fe80:: / fc00:: 等一律拒绝，公网域名走 DNS 不产生字面量）
 * - 元数据/内部域名（*.internal / *.local / metadata.* 等）
 * - IP 伪装（十进制/八进制/十六进制混淆 → parseIpv4 归一化后检查）
 * 通过时静默返回，失败时抛错（含原因）。
 */
export function assertPublicHttpUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('无效的视频 URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('仅支持 http/https 链接');
  }
  const host = u.hostname.toLowerCase();

  // IPv6 字面量一律拒绝（回环 ::1 / 链路本地 fe80:: / ULA fc00:: 等）
  if (host.includes(':')) {
    throw new Error('不允许 IPv6 字面量地址');
  }
  // 回环主机名（localhost 非 IP 字面量，parseIpv4 无法识别，需显式拦截）
  if (host === 'localhost' || host === 'localhost.localdomain') {
    throw new Error('不允许访问内网/回环地址');
  }
  // 元数据/内部域名
  if (isMetadataHostname(host)) {
    throw new Error('不允许访问元数据/内部域名');
  }
  // IP 字面量（含混淆编码）：链路本地 / 回环 / 私网 全部拒绝
  const ip = parseIpv4(host);
  if (ip) {
    if (isLinkLocal(ip)) throw new Error('不允许访问链路本地地址');
    if (isPrivateOrLoopback(ip)) throw new Error('不允许访问内网/回环地址');
  }
  // 域名形式：复用基础 SSRF 检查（协议+链路本地域名兜底）
  if (!isSafeFetchUrl(raw)) {
    throw new Error('地址存在 SSRF 风险');
  }
}

/** YouTube / 通用视频下载（yt-dlp），返回文件 Buffer 与标题 */
export function downloadWithYtDlp(url: string, format: string, quality: string): Promise<{ buffer: Buffer; title: string; ext: string }> {
  // SEC-001: 入口强制 SSRF 校验（即使被其他调用方绕过路由层，核心函数仍防御）
  assertPublicHttpUrl(url);
  return new Promise((resolveP, rejectP) => {
    const ytDlp = resolveYtDlpPath();
    const tmpDir = resolve(process.env.TEMP || '.', `ytdl-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });

    const audioOnly = ['mp3', 'm4a', 'wav', 'flac', 'aac', 'ogg', 'opus'].includes(format);
    const args: string[] = [];
    if (audioOnly) {
      args.push('-x', '--audio-format', format, '--audio-quality', '0');
      if (format === 'mp3') args.push('--postprocessor-args', 'ffmpeg:-b:a 192k');
    } else {
      const fmtMap: Record<string, string> = {
        '1080': 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
        '720': 'bestvideo[height<=720]+bestaudio/best[height<=720]/best',
        '480': 'bestvideo[height<=480]+bestaudio/best[height<=480]/best',
      };
      args.push('-f', fmtMap[quality] || 'bestvideo+bestaudio/best');
      args.push('--merge-output-format', format === 'webm' ? 'webm' : 'mp4');
    }
    args.push('--no-playlist', '--no-warnings', '-o', resolve(tmpDir, '%(title)s.%(ext)s'), url);

    execFile(ytDlp, args, { timeout: 600000, maxBuffer: 100 * 1024 * 1024 }, (err) => {
      try {
        if (err) {
          rejectP(new Error(`下载失败: ${err.message}（如为网络/反爬问题，请稍后重试或更新 yt-dlp）`));
          return;
        }
        const files = readdirSync(tmpDir).filter(f => !f.endsWith('.part') && !f.endsWith('.ytdl'));
        if (files.length === 0) { rejectP(new Error('下载完成但未找到输出文件')); return; }
        // 优先取非 .webm/.m4a 中间文件的最终产物：取最后一个文件
        const outFile = files[files.length - 1];
        const fullPath = resolve(tmpDir, outFile);
        const title = outFile.replace(/\.[^.]+$/, '');
        const ext = (outFile.includes('.') ? outFile.split('.').pop()!.toLowerCase() : 'mp4');
        resolveP({ buffer: readFileSync(fullPath), title, ext });
      } catch (e) { rejectP(e instanceof Error ? e : new Error(String(e))); }
      finally {
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_e: unknown) { /* ignore - intentional */ }
      }
    });
  });
}

/** 注册视频工具路由 */
export function registerVideoRoutes(app: FastifyInstance, config: BackendConfig): void {
  // 从视频中提取音频
  app.post('/api/toolbox/video-extract', {
    schema: {
      description: '从视频中提取音频（ffmpeg）',
      tags: ['工具箱'],
    },
  }, async (request, reply) => {
    const body = request.body as { files: { name: string; data: string }[]; targetFormat: string };
    const files = body.files || [];
    if (!Array.isArray(files) || files.length === 0) {
      return reply.code(400).send({ error: '没有上传文件' });
    }
    const target = (body.targetFormat || '').toLowerCase();
    if (!/^[a-z0-9]{2,8}$/.test(target) || !AUDIO_EXTS.has(target)) {
      return reply.code(400).send({ error: `不支持的目标音频格式: ${target}` });
    }

    const dir = exportDir(config);
    const results: { file: string; output: string; success: boolean; message?: string }[] = [];
    for (const f of files) {
      const name = f.name || 'video.mp4';
      const base64 = (f.data || '').split(',')[1] || f.data || '';
      const buf = Buffer.from(base64, 'base64');
      const ext = (name.includes('.') ? name.split('.').pop()!.toLowerCase() : 'mp4');
      if (!VIDEO_EXTS.has(ext)) {
        results.push({ file: name, output: '', success: false, message: `不支持的视频格式: ${ext}` });
        continue;
      }
      // SEC-002: magic bytes 校验 — 视频/音频扩展名必须与文件真实签名一致
      const magicOk = assertMagicMatches(buf, ext);
      if (!magicOk.ok) {
        results.push({ file: name, output: '', success: false, message: `文件类型与扩展名不符（实际: ${magicOk.detected}）` });
        continue;
      }
      try {
        const outBuf = await extractAudioFromVideo(buf, ext, target);
        const outName = `${randomUUID()}.${target}`;
        writeFileSync(resolve(dir, outName), outBuf);
        results.push({ file: name, output: `/api/toolbox/download/${outName}`, success: true });
      } catch (e: unknown) {
        results.push({ file: name, output: '', success: false, message: e instanceof Error ? e.message : String(e) });
      }
    }
    return { results };
  });

  // YouTube / 通用视频下载
  app.post('/api/toolbox/youtube-download', {
    schema: {
      description: '从 YouTube 等视频站下载视频/音频（yt-dlp）',
      tags: ['工具箱'],
    },
  }, async (request, reply) => {
    const body = request.body as { url: string; format?: string; quality?: string };
    const url = (body.url || '').trim();
    if (!url) return reply.code(400).send({ error: '请输入视频 URL' });
    // SEC-001: SSRF 收紧校验（拦截内网/回环/元数据地址）
    try {
      assertPublicHttpUrl(url);
    } catch (e: unknown) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : 'URL 校验失败' });
    }

    const format = (body.format || 'mp4').toLowerCase();
    const allowedFormats = ['mp4', 'webm', 'mp3', 'm4a', 'wav', 'flac', 'aac', 'ogg', 'opus'];
    if (!allowedFormats.includes(format)) return reply.code(400).send({ error: `不支持的格式: ${format}` });

    const quality = (body.quality || 'best').toLowerCase();
    const allowedQuality = ['best', '1080', '720', '480'];
    if (!allowedQuality.includes(quality)) return reply.code(400).send({ error: `不支持的质量: ${quality}` });

    try {
      const { buffer, title, ext } = await downloadWithYtDlp(url, format, quality);
      const outName = `${randomUUID()}.${ext}`;
      writeFileSync(resolve(exportDir(config), outName), buffer);
      return {
        success: true,
        output: `/api/toolbox/download/${outName}`,
        title,
        format: ext,
        size: buffer.length,
      };
    } catch (e: unknown) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 检测工具可用性（前端用于禁用按钮/提示）
  // 检测逻辑：内置 build/ 目录 → 环境变量 → 系统 PATH；缺失时给出下载指引
  app.get('/api/toolbox/tools-status', {
    schema: { description: '检测外部工具依赖（ffmpeg / yt-dlp / LibreOffice）', tags: ['工具箱'] },
  }, async () => {
    const ffmpegPath = resolveFfmpegPath();
    const ytDlpPath = resolveYtDlpPath();
    // LibreOffice 检测：内置目录 → 环境变量 → 常见安装路径 → 系统 PATH
    const sofficeCandidates = [
      process.env.SOFFICE_PATH || '',
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files\\LibreOffice\\program\\soffice.com',
      resolve(__dirname, '../../../build/soffice/program/soffice.exe'),
    ];
    const sofficeFound = sofficeCandidates.find(c => c && existsSync(c)) || 'soffice';

    return {
      ffmpeg: {
        // 修复：真实探测工具可用性（原先 existsSync('ffmpeg') 是相对 cwd 的假检查，
        // 系统 PATH 中已安装的 ffmpeg 也会被误报为"未检测到"）
        available: isToolAvailable(ffmpegPath),
        source: ffmpegPath !== 'ffmpeg' ? 'bundled' : 'system',
        detectPath: ffmpegPath !== 'ffmpeg' ? ffmpegPath : '',
        downloadUrl: 'https://ffmpeg.org/download.html',
        downloadHint: 'Windows 推荐：https://www.gyan.dev/ffmpeg/builds/（下载 release-essentials 版，解压后把 bin 目录加入 PATH，或设置 FFMPEG_PATH 环境变量指向 ffmpeg.exe）',
      },
      ytDlp: {
        available: isToolAvailable(ytDlpPath),
        source: ytDlpPath !== 'yt-dlp' ? 'bundled' : 'system',
        detectPath: ytDlpPath !== 'yt-dlp' ? ytDlpPath : '',
        downloadUrl: 'https://github.com/yt-dlp/yt-dlp/releases',
        downloadHint: 'Windows 下载 yt-dlp.exe，放入任意目录并加入 PATH，或设置 YT_DLP_PATH 环境变量指向该文件',
      },
      libreOffice: {
        available: isToolAvailable(sofficeFound),
        source: sofficeFound !== 'soffice' ? 'installed' : 'missing',
        detectPath: sofficeFound !== 'soffice' ? sofficeFound : '',
        downloadUrl: 'https://www.libreoffice.org/download/download-libreoffice/',
        downloadHint: '安装后默认路径为 C:\\Program Files\\LibreOffice，或设置 SOFFICE_PATH 环境变量指向 soffice.exe',
      },
    };
  });
}
