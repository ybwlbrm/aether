import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { PageHeader } from '../components/PageHeader';
import { confirm as confirmDialog } from '../components/ui/confirm-dialog';
import { KeyRound, Plus, Trash2, Eye, EyeOff, Lock, Unlock, Copy, CheckCircle2, Pencil, Settings } from 'lucide-react';

interface VaultEntry {
  id: string;
  name: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  category: string;
  createdAt: string;
}

// ---- Web Crypto AES-GCM 加密工具 ----
// P0-4: 随机盐 + 随机 IV，不再用固定盐
const enc = new TextEncoder();
const dec = new TextDecoder();
const VAULT_META_KEY = 'vault_meta'; // { salt: base64, iterations: number, version: 2 }
const VAULT_ITERATIONS = 600000;     // P0-4: 提升到 600k（OWASP 2024+ 建议）

async function getKey(masterPass: string, salt: Uint8Array, iterations = VAULT_ITERATIONS): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(masterPass) as BufferSource, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

async function encrypt(plain: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, enc.encode(plain) as BufferSource);
  const buf = new Uint8Array(iv.length + cipher.byteLength);
  buf.set(iv, 0); buf.set(new Uint8Array(cipher), iv.length);
  return btoa(String.fromCharCode(...Array.from(buf)));
}

async function decrypt(payload: string, key: CryptoKey): Promise<string> {
  const buf = Uint8Array.from(atob(payload), c => c.charCodeAt(0));
  const iv = buf.slice(0, 12);
  const data = buf.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, data as BufferSource);
  return dec.decode(plain);
}

/** P0-4: 从 meta 中读取盐，或首次创建 */
function getVaultSalt(): Uint8Array {
  try {
    const metaRaw = localStorage.getItem(VAULT_META_KEY);
    if (metaRaw) {
      const meta = JSON.parse(metaRaw);
      if (meta.salt) {
        const binary = atob(meta.salt);
        return Uint8Array.from(binary, c => c.charCodeAt(0));
      }
    }
  } catch (_e: unknown) { /* ignore - intentional */ }
  // 首次：生成随机盐并存储
  const salt = crypto.getRandomValues(new Uint8Array(16));
  localStorage.setItem(VAULT_META_KEY, JSON.stringify({ salt: btoa(String.fromCharCode(...Array.from(salt))), iterations: VAULT_ITERATIONS, version: 2 }));
  return salt;
}

export function Vault() {
  const [unlocked, setUnlocked] = useState(false);
  const [masterPass, setMasterPass] = useState('');
  const [warning, setWarning] = useState('');
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [newEntry, setNewEntry] = useState({ name: '', username: '', password: '', url: '', notes: '', category: '' });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [visibleIds, setVisibleIds] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('全部');
  const [showChangePass, setShowChangePass] = useState(false);
  const [oldPass, setOldPass] = useState('');
  const [newPass, setNewPass] = useState('');
  // 主密码仅保存在内存中，不写入 localStorage（防 XSS 窃取）
  const sessionKeyRef = useRef<string>('');
  // P0-4: 限速 — 连续 5 次失败后锁定 30s
  const failRef = useRef<{ count: number; until: number }>({ count: 0, until: 0 });
  // P1-8: 自动锁定 — 解锁后 5 分钟无操作自动锁定
  const AUTO_LOCK_MS = 5 * 60 * 1000;
  const lockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetLockTimer = () => {
    if (lockTimerRef.current) clearTimeout(lockTimerRef.current);
    lockTimerRef.current = setTimeout(() => {
      setUnlocked(false);
      setEntries([]);
      sessionKeyRef.current = '';
      // P2 修复：自动锁定时重置 UI 状态，防残留
      setVisibleIds(new Set());
      setSearchQuery('');
      setSelectedCategory('全部');
      setShowNew(false);
      setShowChangePass(false);
      setWarning('自动锁定：长时间未操作');
    }, AUTO_LOCK_MS);
  };
  // 解锁后启动自动锁定计时器，用户交互时重置
  useEffect(() => {
    if (unlocked) {
      resetLockTimer();
      const events = ['mousedown', 'keydown', 'touchstart', 'scroll'];
      const handler = () => resetLockTimer();
      events.forEach(e => window.addEventListener(e, handler, { passive: true }));
      return () => {
        if (lockTimerRef.current) clearTimeout(lockTimerRef.current);
        events.forEach(e => window.removeEventListener(e, handler));
      };
    }
  }, [unlocked]);

  // 检查是否已初始化
  useEffect(() => {
    if (localStorage.getItem('vault_initialized') !== 'true') {
      setWarning('首次使用：请输入主密码创建密码库');
    }
  }, []);

  const handleUnlock = async () => {
    if (!masterPass) { setWarning('请输入主密码'); return; }
    // P0-3 修复：首次创建密码库要求至少 8 位，避免空密码/弱密码库
    const hasVault = localStorage.getItem('vault_initialized') === 'true';
    if (!hasVault && masterPass.length < 8) {
      setWarning('首次创建密码库：主密码至少需要 8 位');
      return;
    }
    // P0-4: 限速检查
    if (Date.now() < failRef.current.until) {
      const secs = Math.ceil((failRef.current.until - Date.now()) / 1000);
      setWarning(`尝试过多，请 ${secs}s 后再试`);
      return;
    }
    try {
      const salt = getVaultSalt();
      const key = await getKey(masterPass, salt);
      if (!hasVault) {
        localStorage.setItem('vault_initialized', 'true');
        localStorage.setItem('vault_data', await encrypt('[]', key));
        setWarning('密码库已创建！');
      } else {
        const raw = await decrypt(localStorage.getItem('vault_data') || '', key).catch(() => '');
        if (!raw) {
          failRef.current.count++;
          if (failRef.current.count >= 5) {
            failRef.current.until = Date.now() + 30000;
            setWarning('主密码错误次数过多，请 30s 后再试');
          } else {
            setWarning(`主密码错误！剩余 ${5 - failRef.current.count} 次尝试`);
          }
          return;
        }
        setEntries(JSON.parse(raw));
        failRef.current.count = 0; // 成功后重置
      }
      // 会话密钥仅存内存，刷新后需重新解锁
      sessionKeyRef.current = masterPass;
      setUnlocked(true);
      setMasterPass('');
      setWarning('');
    } catch (e: unknown) {
      setWarning('解锁失败: ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  // 解锁后增删改用内存中的会话密钥
  const persist = async (next: VaultEntry[]) => {
    setEntries(next);
    const salt = getVaultSalt();
    const key = await getKey(sessionKeyRef.current, salt);
    localStorage.setItem('vault_data', await encrypt(JSON.stringify(next), key));
  };

  const addEntry = async () => {
    if (!newEntry.name || !newEntry.password) return;
    const entry = { id: Date.now().toString(), ...newEntry, createdAt: new Date().toISOString() };
    await persist([entry, ...entries]);
    setNewEntry({ name: '', username: '', password: '', url: '', notes: '', category: '' });
    setShowNew(false);
  };

  const saveEdit = async () => {
    if (!editingId) return;
    const next = entries.map(e => e.id === editingId ? { ...e, name: newEntry.name || e.name, username: newEntry.username, password: newEntry.password || e.password, url: newEntry.url, notes: newEntry.notes, category: newEntry.category } : e);
    await persist(next);
    setEditingId(null);
    setNewEntry({ name: '', username: '', password: '', url: '', notes: '', category: '' });
  };

  const startEdit = (e: VaultEntry) => {
    setEditingId(e.id);
    setNewEntry({ name: e.name, username: e.username, password: e.password, url: e.url, notes: e.notes, category: e.category || '' });
    setShowNew(true);
  };

  // P0-4: 删除前二次确认
  const deleteEntry = async (id: string) => {
    const entry = entries.find(e => e.id === id);
    if (entry && await confirmDialog(`确定删除密码 "${entry.name}"？此操作不可撤销。`)) {
      await persist(entries.filter(e => e.id !== id));
    }
  };

  const toggleVisible = (id: string) => {
    const next = new Set(visibleIds);
    if (next.has(id)) { next.delete(id); } else { next.add(id); }
    setVisibleIds(next);
  };
  const copyPass = (id: string) => {
    const e = entries.find(x => x.id === id);
    if (e) { navigator.clipboard.writeText(e.password); setCopied(id); setTimeout(() => setCopied(null), 1500); }
  };

  // P0-4: 修改主密码
  const handleChangePass = async () => {
    if (!oldPass || !newPass || newPass.length < 8) { setWarning('新密码至少 8 位'); return; }
    try {
      const oldSalt = getVaultSalt();
      const oldKey = await getKey(oldPass, oldSalt);
      const raw = await decrypt(localStorage.getItem('vault_data') || '', oldKey).catch(() => '');
      if (!raw) { setWarning('旧密码错误'); return; }
      // 用新随机盐 + 新密码重加密
      const newSalt = crypto.getRandomValues(new Uint8Array(16));
      const newKey = await getKey(newPass, newSalt);
      localStorage.setItem('vault_data', await encrypt(raw, newKey));
      localStorage.setItem(VAULT_META_KEY, JSON.stringify({ salt: btoa(String.fromCharCode(...Array.from(newSalt))), iterations: VAULT_ITERATIONS, version: 2 }));
      sessionKeyRef.current = newPass;
      setOldPass(''); setNewPass('');
      setShowChangePass(false);
      setWarning('主密码修改成功！');
    } catch (e: unknown) { setWarning('修改失败: ' + (e instanceof Error ? e.message : String(e))); }
  };

  // P1-1 修复：协议白名单 — 仅允许 http/https，防 javascript: 存储型 XSS
  function safeUrl(url: string): string {
    try {
      const u = new URL(url);
      return (u.protocol === 'http:' || u.protocol === 'https:') ? url : '';
    } catch {
      return '';
    }
  }

  // 按分类+搜索过滤
  const categories = ['全部', ...new Set(entries.map(e => e.category || '未分类'))];
  const filteredEntries = entries.filter(e => {
    if (selectedCategory !== '全部' && (e.category || '未分类') !== selectedCategory) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return e.name.toLowerCase().includes(q) || e.username.toLowerCase().includes(q) || e.url.toLowerCase().includes(q) || (e.notes || '').toLowerCase().includes(q);
    }
    return true;
  });

  // P2 安全修复：导出不再输出明文 JSON，改为使用一次性导出密码（PBKDF2+AES-GCM）加密，
  // 并附上 .aethervault 格式说明，防止备份文件泄露全部密码明文。
  const exportVault = async () => {
    if (entries.length === 0) { alert('密码库为空，无需导出'); return; }
    const exportPass = window.prompt('设置导出文件的加密密码（至少 8 位）\n⚠️ 请牢记该密码：解密导出文件时需要它。');
    if (!exportPass) return;
    if (exportPass.length < 8) { alert('导出密码至少需要 8 位'); return; }

    const data = { app: 'aether-vault', version: 1, exportedAt: new Date().toISOString(), entries: entries.map(e => ({ name: e.name, username: e.username, password: e.password, url: e.url, category: e.category, notes: e.notes })) };

    // PBKDF2-AES-GCM 加密
    const enc2 = new TextEncoder();
    const exportSalt = crypto.getRandomValues(new Uint8Array(16));
    const exportIv = crypto.getRandomValues(new Uint8Array(12));
    const keyMaterial = await crypto.subtle.importKey('raw', enc2.encode(exportPass) as BufferSource, 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: exportSalt as BufferSource, iterations: 600000, hash: 'SHA-256' },
      keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
    );
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: exportIv as BufferSource }, key, enc2.encode(JSON.stringify(data)) as BufferSource);

    const wrap = (b: Uint8Array) => btoa(String.fromCharCode(...Array.from(b)));
    const file = JSON.stringify({
      aethervault: 1,
      kdf: 'pbkdf2-sha256',
      iterations: 600000,
      salt: wrap(exportSalt),
      iv: wrap(exportIv),
      data: wrap(new Uint8Array(cipher)),
    });

    const blob = new Blob([file], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'vault-export.aethervault.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    alert('✅ 导出完成\n文件已加密保存。下次导入时需输入此加密密码。');
  };

  const importVault = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const raw = ev.target?.result as string;
        let imported: any[] | null = null;

        // 兼容旧版明文导出（仅提示风险并允许导入）
        const plainParsed = JSON.parse(raw);
        if (Array.isArray(plainParsed)) {
          imported = plainParsed;
        } else if (plainParsed?.aethervault === 1) {
          // 新版加密导出格式：要求输入密码解密
          const decryptPass = window.prompt('该导出文件已加密，请输入解密密码：');
          if (!decryptPass) return;
          const dec2 = new TextDecoder();
          const unwrap = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
          const salt = unwrap(plainParsed.salt);
          const iv = unwrap(plainParsed.iv);
          const keyMaterial2 = await crypto.subtle.importKey('raw', new TextEncoder().encode(decryptPass) as BufferSource, 'PBKDF2', false, ['deriveKey']);
          const key2 = await crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt: salt as BufferSource, iterations: plainParsed.iterations || 600000, hash: 'SHA-256' },
            keyMaterial2, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
          );
          const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key2, unwrap(plainParsed.data) as BufferSource);
          const parsedData = JSON.parse(dec2.decode(decrypted));
          imported = Array.isArray(parsedData.entries) ? parsedData.entries : (Array.isArray(parsedData) ? parsedData : null);
        } else {
          alert('无法识别的导出文件格式'); return;
        }

        if (!imported) { alert('格式错误'); return; }
        // P1-1 修复：导入时过滤非 http/https 协议的 url，防 javascript: 存储型 XSS
        const sanitized = imported.map((x: any) => ({
          ...x,
          url: x.url ? safeUrl(x.url) : '',
        }));
        const next = [...sanitized.map((x: any) => ({ ...x, id: Date.now().toString() + Math.random(), createdAt: new Date().toISOString() })), ...entries];
        await persist(next);
        alert(`导入成功！${sanitized.length} 条`);
      } catch (err) {
        alert('导入失败：' + (err instanceof Error ? err.message : '无效的文件或密码错误'));
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)', backgroundImage: 'var(--bg-gradient)' }}>
      <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '0 24px' }}>
        <PageHeader title="密码库" description="本地加密存储密码（AES-256-GCM + PBKDF2 600k 迭代）" icon={<KeyRound size={22} />} color="var(--color-warning)" />

        {!unlocked ? (
          <div className="glass-card" style={{ maxWidth: 480, margin: '40px auto' }}>
            <div className="text-center mb-6">
              <Lock size={40} style={{ color: 'var(--text-tertiary)', margin: '0 auto 12px', display: 'block' }} />
              <h3 style={{ fontSize: '18px', fontWeight: 600, color: 'var(--text-primary)' }}>解锁密码库</h3>
              <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: 4 }}>
                密码使用 Web Crypto AES-GCM 加密，仅存储在本机
              </p>
            </div>
            <input className="input" type="password" placeholder="输入主密码" value={masterPass}
              onChange={e => setMasterPass(e.target.value)}
              onKeyDown={e => {
                // P0-4 修复：IME 组词时 Enter 不触发解锁，防止中文输入法误触
                if (e.key === 'Enter' && !(e.nativeEvent as any).isComposing) handleUnlock();
              }} />
            <button className="btn btn-primary w-full mt-3" onClick={handleUnlock}>
              <Unlock size={16} /> {localStorage.getItem('vault_initialized') === 'true' ? '解锁' : '创建并解锁'}
            </button>
            {warning && <p className="text-sm mt-3" style={{ color: 'var(--color-warning)' }}>{warning}</p>}
          </div>
        ) : (
          <div className="glass-card" style={{ padding: '24px' }}>
            <div className="flex items-center justify-between mb-6">
              <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)' }}>
                已解锁 · {entries.length} 个密码
              </h3>
              <div className="flex items-center gap-2">
                <input type="file" accept=".json" style={{ display: 'none' }} onChange={importVault} id="vault-import" />
                <label htmlFor="vault-import" className="btn btn-ghost btn-sm" style={{ fontSize: 12, cursor: 'pointer' }}>导入</label>
                <button className="btn btn-ghost btn-sm" onClick={exportVault} style={{ fontSize: 12 }}>导出</button>
                {/* P0-4: 修改主密码入口 */}
                <button className="btn btn-ghost btn-sm" onClick={() => setShowChangePass(!showChangePass)} style={{ fontSize: 12 }} title="修改主密码">
                  <Settings size={14} /> 改密
                </button>
                <button className="btn btn-primary" onClick={() => setShowNew(!showNew)}><Plus size={16} /> 新增</button>
              </div>
            </div>

            {/* P0-4: 修改主密码面板 */}
            {showChangePass && (
              <div style={{ padding: 16, borderRadius: 12, background: 'var(--bg-surface)', border: '1px solid var(--border-primary)', marginBottom: 16 }}>
                <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
                  <input className="input" type="password" placeholder="旧密码" value={oldPass} onChange={e => setOldPass(e.target.value)} />
                  <input className="input" type="password" placeholder="新密码（至少 8 位）" value={newPass} onChange={e => setNewPass(e.target.value)} />
                </div>
                <div className="flex gap-2 mt-3">
                  <button className="btn btn-primary btn-sm" onClick={handleChangePass}>确认修改</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => { setShowChangePass(false); setOldPass(''); setNewPass(''); }}>取消</button>
                </div>
              </div>
            )}

            {/* 搜索+分类筛选 */}
            <div className="flex items-center gap-3 mb-4">
              <input className="input" style={{ height: 36, fontSize: 13, flex: 1, borderRadius: 10 }} value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="搜索密码..." />
              <div className="flex gap-1 flex-wrap">
                {categories.map(c => (
                  <button key={c} onClick={() => setSelectedCategory(c)}
                    className="px-4 py-2.5 rounded-[14px] text-xs font-medium transition-all"
                    style={{ minHeight: 36,
                      background: selectedCategory === c ? 'rgba(94,158,255,0.15)' : 'var(--bg-surface)',
                      color: selectedCategory === c ? 'var(--color-accent)' : 'var(--text-secondary)',
                      border: `1px solid ${selectedCategory === c ? 'rgba(94,158,255,0.3)' : 'var(--border-primary)'}`,
                    }}>
                    {c}
                  </button>
                ))}
              </div>
            </div>

{showNew && (
              <div style={{ padding: 16, borderRadius: 12, background: 'var(--bg-surface)', border: '1px solid var(--border-primary)', marginBottom: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <input className="input" placeholder="名称（必填）" value={newEntry.name} onChange={e => setNewEntry(p => ({ ...p, name: e.target.value }))} />
                <input className="input" placeholder="网址（可选）" value={newEntry.url} onChange={e => setNewEntry(p => ({ ...p, url: e.target.value }))} />
                <input className="input" placeholder="用户名" value={newEntry.username} onChange={e => setNewEntry(p => ({ ...p, username: e.target.value }))} />
                <input className="input" type="password" placeholder="密码（必填）" value={newEntry.password} onChange={e => setNewEntry(p => ({ ...p, password: e.target.value }))} />
                <input className="input" placeholder="分类（可选）" value={newEntry.category} onChange={e => setNewEntry(p => ({ ...p, category: e.target.value }))} />
                <input className="input" placeholder="备注" value={newEntry.notes} onChange={e => setNewEntry(p => ({ ...p, notes: e.target.value }))} />
                {/* P0-4: 按钮顺序修正 — 保存在左（惯用），取消在右 */}
                <button className="btn btn-ghost" onClick={() => { setShowNew(false); setEditingId(null); }}>取消</button>
                <button className="btn btn-primary" onClick={editingId ? saveEdit : addEntry} disabled={!newEntry.name || !newEntry.password}>
                  {editingId ? '保存修改' : '保存'}
                </button>
              </div>
            )}

            {filteredEntries.length === 0 ? (
              <div className="empty-state py-12">
                <KeyRound size={36} className="empty-state-icon" />
                <div className="empty-state-title">{searchQuery || selectedCategory !== '全部' ? '无匹配密码' : '暂无密码'}</div>
                <div className="empty-state-desc">{searchQuery || selectedCategory !== '全部' ? '尝试修改搜索条件' : '点击「新增」添加第一个密码'}</div>
              </div>
            ) : (
              <div className="space-y-3">
                {filteredEntries.map(e => (
                  <motion.div key={e.id} className="rounded-[14px] p-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-primary)' }}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>{e.name}</span>
                          {e.category && <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(94,158,255,0.12)', color: 'var(--color-accent)' }}>{e.category}</span>}
                          {e.url && safeUrl(e.url) && <a href={safeUrl(e.url)} target="_blank" rel="noopener noreferrer" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>{e.url}</a>}
                        </div>
                        {e.username && <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: 2 }}>👤 {e.username}</p>}
                        <div className="flex items-center gap-2 mt-2">
                          <span style={{ fontSize: '13px', fontFamily: 'var(--font-mono)', color: visibleIds.has(e.id) ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>
                            {visibleIds.has(e.id) ? e.password : '••••••••'}
                          </span>
                          <button onClick={() => toggleVisible(e.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: 10, minHeight: 44, minWidth: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }} aria-label={visibleIds.has(e.id) ? '隐藏密码' : '显示密码'}>
                            {visibleIds.has(e.id) ? <EyeOff size={16} /> : <Eye size={16} />}
                          </button>
                          <button onClick={() => copyPass(e.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: copied === e.id ? 'var(--color-success)' : 'var(--text-tertiary)', padding: 10, minHeight: 44, minWidth: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }} aria-label="复制密码">
                            {copied === e.id ? <CheckCircle2 size={16} /> : <Copy size={16} />}
                          </button>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button onClick={() => startEdit(e)} title="编辑" style={{ color: 'var(--text-tertiary)', cursor: 'pointer', background: 'none', border: 'none', padding: 4 }} aria-label="编辑">
                          <Pencil size={14} />
                        </button>
                        {/* P0-4: 删除有二次确认 */}
                        <button onClick={() => deleteEntry(e.id)} style={{ color: 'var(--text-tertiary)', cursor: 'pointer', background: 'none', border: 'none', padding: 4, flexShrink: 0 }} aria-label="删除" title="删除">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}