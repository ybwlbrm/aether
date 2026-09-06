/**
 * SEC-002: 上传文件 magic bytes（文件签名）校验
 *
 * 背景：背景图 / 工具箱转换 / 视频音频提取的上传端点仅检查 MIME/扩展名，
 * 攻击者可把任意文件改名（如 evil.exe → evil.png）绕过白名单。
 * 本模块通过文件头字节（magic numbers）识别真实类型，杜绝伪装。
 * 注意：zip 族（docx/xlsx/pptx）无法仅靠头字节区分，统一识别为 'zip'，
 * 由调用方按扩展名白名单放行。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectMagicType, assertMagicMatches, DetectedType } from './magic-bytes.js';

function buf(...bytes: number[]): Buffer {
  return Buffer.from(bytes);
}

describe('magic-bytes detectMagicType (SEC-002)', () => {
  test('detects PNG (89 50 4E 47 0D 0A 1A 0A)', () => {
    assert.equal(detectMagicType(buf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00)), 'png');
  });

  test('detects JPEG (FF D8 FF)', () => {
    assert.equal(detectMagicType(buf(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46)), 'jpg');
    assert.equal(detectMagicType(buf(0xff, 0xd8, 0xff, 0xe1, 0x00, 0x00, 0x45, 0x78, 0x69, 0x66)), 'jpg');
  });

  test('detects GIF (GIF87a/GIF89a)', () => {
    assert.equal(detectMagicType(Buffer.from('GIF89a\x01\x00\x01\x00')), 'gif');
    assert.equal(detectMagicType(Buffer.from('GIF87a')), 'gif');
  });

  test('detects WEBP (RIFF....WEBP)', () => {
    assert.equal(detectMagicType(Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WEBP')])), 'webp');
  });

  test('detects BMP (BM)', () => {
    assert.equal(detectMagicType(Buffer.concat([Buffer.from('BM'), Buffer.from([0x00, 0x00, 0x00, 0x00])])), 'bmp');
  });

  test('detects PDF (%PDF)', () => {
    assert.equal(detectMagicType(Buffer.from('%PDF-1.7\n%...')), 'pdf');
  });

  test('detects zip family docx/xlsx/pptx as zip (PK)', () => {
    assert.equal(detectMagicType(buf(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00)), 'zip');
  });

  test('detects MP4 (....ftyp)', () => {
    assert.equal(detectMagicType(buf(0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d)), 'mp4');
  });

  test('detects M4A (ftyp M4A brand)', () => {
    assert.equal(detectMagicType(buf(0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20)), 'm4a');
  });

  test('detects MOV (ftyp qt brand)', () => {
    assert.equal(detectMagicType(buf(0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20)), 'mov');
  });

  test('detects MKV/WEBM (1A 45 DF A3)', () => {
    assert.equal(detectMagicType(buf(0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81)), 'mkv');
  });

  test('detects AVI (RIFF....AVI)', () => {
    assert.equal(detectMagicType(Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('AVI ')])), 'avi');
  });

  test('detects FLV (FLV)', () => {
    assert.equal(detectMagicType(Buffer.from('FLV\x01\x05')), 'flv');
  });

  test('detects WMV (ASF GUID)', () => {
    assert.equal(detectMagicType(buf(0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9)), 'wmv');
  });

  test('detects MP3 (ID3 tag)', () => {
    assert.equal(detectMagicType(Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00')), 'mp3');
  });

  test('detects WAV (RIFF....WAVE)', () => {
    assert.equal(detectMagicType(Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0x00, 0x00, 0x00]), Buffer.from('WAVE')])), 'wav');
  });

  test('detects FLAC (fLaC)', () => {
    assert.equal(detectMagicType(Buffer.from('fLaC\x00\x00\x00\x22')), 'flac');
  });

  test('detects OGG/OPUS (OggS)', () => {
    assert.equal(detectMagicType(Buffer.from('OggS\x00\x02\x00\x00\x00')), 'ogg');
  });

  test('returns unknown for empty/mismatched bytes', () => {
    assert.equal(detectMagicType(Buffer.alloc(0)), 'unknown');
    assert.equal(detectMagicType(buf(0x4d, 0x5a, 0x90, 0x00)), 'unknown'); // MZ = PE exe header
  });

  test('returns unknown for non-utf8 binary data', () => {
    assert.equal(detectMagicType(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0xff, 0xfe])), 'unknown');
  });
});

describe('magic-bytes assertMagicMatches (SEC-002)', () => {
  test('accepts matching png', () => {
    const r = assertMagicMatches(buf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 'png');
    assert.equal(r.ok, true);
  });

  test('REJECTS evil.exe bytes labeled .png (MZ header)', () => {
    // MZ header（Windows PE exe）伪装成 .png
    const evil = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(20)]);
    const r = assertMagicMatches(evil, 'png');
    assert.equal(r.ok, false);
    assert.equal(r.detected, 'unknown');
  });

  test('REJECTS png bytes labeled .jpg', () => {
    const png = buf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    const r = assertMagicMatches(png, 'jpg');
    assert.equal(r.ok, false);
    assert.equal(r.detected, 'png');
  });

  test('accepts zip labeled docx/xlsx/pptx', () => {
    const zip = buf(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00);
    assert.equal(assertMagicMatches(zip, 'docx').ok, true);
    assert.equal(assertMagicMatches(zip, 'xlsx').ok, true);
    assert.equal(assertMagicMatches(zip, 'pptx').ok, true);
    assert.equal(assertMagicMatches(zip, 'png').ok, false);
  });

  test('accepts video/audio extensions against magic', () => {
    const mp4 = buf(0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d);
    assert.equal(assertMagicMatches(mp4, 'mp4').ok, true);
    const mkv = buf(0x1a, 0x45, 0xdf, 0xa3, 0x9f);
    assert.equal(assertMagicMatches(mkv, 'mkv').ok, true);
    assert.equal(assertMagicMatches(mkv, 'webm').ok, true);
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x00, 0x00, 0x00, 0x00]), Buffer.from('WAVE')]);
    assert.equal(assertMagicMatches(wav, 'wav').ok, true);
  });

  test('accepts UTF-8 text files for text-ish extensions', () => {
    const csv = Buffer.from('a,b,c\n1,2,3\n中文标题,值\n');
    assert.equal(assertMagicMatches(csv, 'csv').ok, true);
    const md = Buffer.from('# 标题\n正文 content\n');
    assert.equal(assertMagicMatches(md, 'md').ok, true);
    const json = Buffer.from('{"a":1,"b":"中文"}');
    assert.equal(assertMagicMatches(json, 'json').ok, true);
    const txt = Buffer.from('plain text 内容');
    assert.equal(assertMagicMatches(txt, 'txt').ok, true);
  });
});