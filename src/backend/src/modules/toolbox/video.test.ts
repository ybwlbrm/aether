/**
 * SEC-001: yt-dlp 下载 URL 必须为公网地址（SSRF 收紧）
 *
 * 背景：/api/toolbox/youtube-download 将用户 URL 直接交给 yt-dlp 执行。
 * yt-dlp 是"拉取式"下载器，若允许内网/回环地址，攻击者可利用它访问
 * 127.0.0.1:3000（后端自身 API）、169.254.169.254（云元数据）与内网资源。
 * 因此与普通 fetch（允许本地 AI Provider）不同，此处必须拒绝所有非公网地址。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicHttpUrl } from './video.js';

describe('video yt-dlp SSRF guard (SEC-001)', () => {
  test('allows public video URLs (youtube/vimeo/https)', () => {
    assert.doesNotThrow(() => assertPublicHttpUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'));
    assert.doesNotThrow(() => assertPublicHttpUrl('https://vimeo.com/123456'));
    assert.doesNotThrow(() => assertPublicHttpUrl('https://example.com/media/video.mp4'));
  });

  test('blocks cloud metadata 169.254.169.254', () => {
    assert.throws(() => assertPublicHttpUrl('http://169.254.169.254/latest/meta-data/'));
  });

  test('blocks link-local 169.254.0.0/16', () => {
    assert.throws(() => assertPublicHttpUrl('http://169.254.42.42/anything'));
  });

  test('blocks loopback 127.0.0.1 / localhost / 0.0.0.0', () => {
    assert.throws(() => assertPublicHttpUrl('http://127.0.0.1:3000/api/export/all'));
    assert.throws(() => assertPublicHttpUrl('http://localhost:3000/api/settings'));
    assert.throws(() => assertPublicHttpUrl('http://0.0.0.0:3000/'));
  });

  test('blocks private ranges 10/8, 172.16/12, 192.168/16', () => {
    assert.throws(() => assertPublicHttpUrl('http://10.0.0.5/path'));
    assert.throws(() => assertPublicHttpUrl('http://172.16.0.5/path'));
    assert.throws(() => assertPublicHttpUrl('http://172.31.255.255/path'));
    assert.throws(() => assertPublicHttpUrl('http://192.168.1.5/path'));
  });

  test('blocks IPv6 loopback / link-local / ULA literals', () => {
    assert.throws(() => assertPublicHttpUrl('http://[::1]:3000/'));
    assert.throws(() => assertPublicHttpUrl('http://[fe80::1]/'));
    assert.throws(() => assertPublicHttpUrl('http://[fc00::1]/'));
  });

  test('blocks obfuscated loopback (decimal / hex integer)', () => {
    assert.throws(() => assertPublicHttpUrl('http://2130706433/'));      // 127.0.0.1
    assert.throws(() => assertPublicHttpUrl('http://0x7f000001/'));      // 127.0.0.1
    assert.throws(() => assertPublicHttpUrl('http://0177.0.0.1/'));      // octal 127.0.0.1
  });

  test('blocks non-http(s) protocols', () => {
    assert.throws(() => assertPublicHttpUrl('file:///etc/passwd'));
    assert.throws(() => assertPublicHttpUrl('ftp://example.com/file'));
    assert.throws(() => assertPublicHttpUrl('javascript:alert(1)'));
  });

  test('blocks metadata / internal hostnames', () => {
    assert.throws(() => assertPublicHttpUrl('http://metadata.google.internal/computeMetadata/v1/'));
    assert.throws(() => assertPublicHttpUrl('http://instance-data.internal/'));
    assert.throws(() => assertPublicHttpUrl('http://myhost.local/'));
  });

  test('blocks malformed urls', () => {
    assert.throws(() => assertPublicHttpUrl('not-a-url'));
    assert.throws(() => assertPublicHttpUrl(''));
  });
});