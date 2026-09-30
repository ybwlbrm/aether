import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Settings as SettingsIcon, Palette, Cloud, Database } from 'lucide-react';
import { PageHeader } from '../components/ui';
import { Tabs, TabList, TabTrigger } from '../components/ui/tabs';
import { useAppStore } from '../store/app';
// T25a: 设置子模块 —— 每个 tab 一个 routes/settings/* 组件，本文件只做导航
import { GeneralPane } from './settings/GeneralPane';
import { AppearanceSettings } from './settings/AppearanceSettings';
import { DataSettings } from './settings/DataSettings';
import { SyncPane } from './settings/SyncPane';

/**
 * Settings — 设置页 **shell**（T25a）。
 *
 * 1018 → ~120 行：只保留页面外壳与 tab 导航，四个子模块各自持有自己的状态与副作用：
 *   general     → settings/GeneralPane（port + 可访问目录 + 数据管理 + Save）
 *   appearance  → settings/AppearanceSettings（唯一 glass / wallpaper UI，appearance store 驱动）
 *   data        → settings/DataSettings（一键导出 / 导入）
 *   sync        → settings/SyncPane（Supabase 云同步）
 *
 * T25 之前这里内联着一整套旧 glass 实现（内联的默认玻璃参数 / CSS 变量直写 /
 * localStorage 直读 / 三组滑块 + data-glass-off 开关 + 6 个背景轮播 state +
 * 裸 CustomEvent 派发），与 appearance store 双轨并存。AppShell（T20）已独占
 * data-material 与 --glass-* token 写入，旧实现已整体退役。
 */

const tabs = [
  { id: 'general', label: 'General', icon: <SettingsIcon size={20} /> },
  { id: 'appearance', label: 'Appearance', icon: <Palette size={20} /> },
  { id: 'data', label: '数据', icon: <Database size={20} /> },
  { id: 'sync', label: '云同步', icon: <Cloud size={20} /> },
];

export function Settings() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('general');

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)', backgroundImage: 'var(--bg-gradient)' }}>
      {/* 页面唯一的宽度/内边距归属者 —— 子模块不再自带 maxWidth + padding（消除嵌套双 padding） */}
      <div style={{ maxWidth: 'var(--content-standard)', margin: '0 auto', padding: '0 16px' }}>
        <PageHeader title="设置" description="应用设置与外观定制" icon={<SettingsIcon size={22} />} />
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <div className="flex gap-8">
            <div className="flex flex-col gap-1 flex-shrink-0" style={{ width: '200px' }}>
              <TabList className="flex flex-col items-stretch gap-1">
                {tabs.map((tab) => (
                  <TabTrigger key={tab.id} value={tab.id} className="nav-item w-full justify-start">
                    {tab.icon}<span>{tab.label}</span>
                  </TabTrigger>
                ))}
              </TabList>
            </div>
            <div className="flex-1 space-y-6">
              {activeTab === 'general' && <GeneralPane navigate={navigate} />}
              {activeTab === 'appearance' && <AppearanceSettings />}
              {activeTab === 'data' && <DataSettings />}
              {activeTab === 'sync' && <SyncPane />}
            </div>
          </div>
        </Tabs>
      </div>
    </div>
  );
}
