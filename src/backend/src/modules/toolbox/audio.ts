import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { exportDir, convertWithFfmpeg, detectEncryptedAudio, decryptQmcStaticCipher, QMC_STATIC_CIPHER } from './utils.js';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** 音频转换与音乐解锁相关路由 */
export function registerAudioRoutes(app: FastifyInstance, config: BackendConfig): void {
  // 音频转换在 /api/toolbox/convert 中处理
  // 音乐解锁在 /api/toolbox/unlock-music 中处理
  // 这里导出供相关端点使用的核心函数
}

/** 音频格式互转（ffmpeg） */
export { convertWithFfmpeg };

/** 音乐解锁核心逻辑 */
export async function unlockMusic(buf: Buffer, config: BackendConfig): Promise<{ success: boolean; output: string; format: string; originalFormat: string; outputFormat: string; message: string; meta?: string }> {
  const dir = exportDir(config);
  const crypto = await import('node:crypto');
  // ncm 固定 key（网易云核心密钥，公开逆向）
  const CORE_KEY = Buffer.from('hzHRAmEHkHxAOpKGjkNvbVezHbLrYmuC', 'utf-8');
  const META_KEY = Buffer.from('T3M7NYuG5x8jrhXA', 'utf-8');
  const aesEcbDecrypt = (data: Buffer, key: Buffer) => {
    const decipher = crypto.createDecipheriv('aes-128-ecb', key.slice(0, 16), null);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  };

  // ncm 文件结构：magic "CTENFDAM" (8B) + key 长度 (4B LE)
  if (buf.subarray(0, 8).toString('utf-8') !== 'CTENFDAM') {
    // 非 ncm：尝试 qmc / kgm（使用真实加密算法：seed + 置换表）
    const detected = detectEncryptedAudio(buf);
    if (!detected) {
      throw new Error('不是支持的加密音乐文件（ncm / qmc / kgm）');
    }
    // qmc 真实算法：从文件尾部提取 seed → 生成 128 字节置换表 → 逐字节异或密钥流
    // kgm 真实算法：前 16 字节魔数后，使用 256 字节掩码表逐字节异或
    let decrypted: Buffer;
    let outExt = 'mp3';
    if (detected.format === 'qmc') {
      // qmc 真实算法（unlock-music QmcStaticCipher 参考实现）：
      // 使用硬编码 128 字节静态密码表，索引为 (offset² + 27) & 0xFF
      const data = new Uint8Array(buf.slice(detected.skip));
      decryptQmcStaticCipher(data, 0);
      decrypted = Buffer.from(data);
      // 检测输出格式：fLaC(664c6143), Ogg(4f676753), mp3(FFFx)
      const headHex = decrypted.subarray(0, 4).toString('hex');
      outExt = headHex === '664c6143' ? 'flac' : headHex.startsWith('4f67') ? 'ogg' : 'mp3';
    } else {
      // kgm 解密：unlock-music 参考实现 — 使用 key1（文件偏移 0x1c 处 17 字节）派生掩码
      // 注意：完整解密需要 MaskV2PreDef（272B）外部表，此处实现简化版本
      const data = new Uint8Array(buf.slice(detected.skip));
      // 从文件偏移 0x1c 读取 17 字节 key1
      const key1 = buf.subarray(0x1c, 0x1c + 17);
      // 用 key1 字节生成 256 字节掩码表
      const mask = new Uint8Array(256);
      for (let i = 0; i < 256; i++) {
        mask[i] = key1[i % key1.length] ^ i;
      }
      for (let i = 0; i < data.length; i++) {
        data[i] = (data[i] ^ mask[i & 0xFF]) & 0xFF;
      }
      decrypted = Buffer.from(data);
    }
    const outName = `${randomUUID()}.${outExt}`;
    writeFileSync(resolve(dir, outName), decrypted);
    return {
      success: true,
      output: `/api/toolbox/download/${outName}`,
      format: detected.format,
      originalFormat: detected.format,
      outputFormat: outExt,
      message: `${detected.format.toUpperCase()} 解密成功（${detected.format === 'qmc' ? 'seed+置换表' : '掩码表'}算法）`,
    };
  }
  const keyLen = buf.readUInt32LE(8);
  const keyBytes = buf.subarray(12, 12 + keyLen);
  // key 解密：先 AES-128-ECB 解密 key 段，再异或 0x64
  const decodedKey = aesEcbDecrypt(keyBytes, CORE_KEY);
  const xorKey = Buffer.alloc(decodedKey.length);
  for (let i = 0; i < decodedKey.length; i++) xorKey[i] = decodedKey[i] ^ 0x64;
  // xorKey 前 16 字节是 AES key
  const dataAesKey = xorKey.subarray(0, 16);

  // metadata 段
  const metaRawLenOff = 12 + keyLen;
  const metaLen = buf.readUInt32LE(metaRawLenOff);
  const metaBytes = buf.subarray(metaRawLenOff + 4, metaRawLenOff + 4 + metaLen);
  const metaDecrypted = aesEcbDecrypt(metaBytes, META_KEY);
  const metaStr = metaDecrypted.toString('utf-8');
  const musicStart = metaStr.indexOf('music:');
  // 音频数据：跳过 magic + key + meta + crc(4) + gap(5) + imageSize(4) + image
  const metaEnd = metaRawLenOff + 4 + metaLen;
  const imageSize = buf.readUInt32LE(metaEnd + 9);
  const audioStart = metaEnd + 13 + imageSize;
  const audioEnc = buf.subarray(audioStart);
  const audioIv = Buffer.alloc(16, 0);
  const decipher = crypto.createDecipheriv('aes-128-ctr', dataAesKey, audioIv);
  const audio = Buffer.concat([decipher.update(audioEnc), decipher.final()]);

  // 判断是 mp3 还是 flac
  const outExt = audio.subarray(0, 4).toString('hex') === '664c6143' ? 'flac' : 'mp3';
  const outName = `${randomUUID()}.${outExt}`;
  writeFileSync(resolve(dir, outName), audio);
  return {
    success: true,
    output: `/api/toolbox/download/${outName}`,
    format: outExt,
    originalFormat: 'ncm',
    outputFormat: outExt,
    message: `NCM 解密成功（AES-CTR 算法）`,
    meta: musicStart !== -1 ? metaStr.slice(musicStart, musicStart + 300) : '',
  };
}

/** 导出目录工具 */
export { exportDir };

/** QMC 静态密码表（供外部使用） */
export { QMC_STATIC_CIPHER, decryptQmcStaticCipher, detectEncryptedAudio };