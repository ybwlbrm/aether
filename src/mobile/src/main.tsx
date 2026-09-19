import React from 'react';
import ReactDOM from 'react-dom/client';
import { initTheme } from './lib/theme';
import App from './App';
import './App.css';

// 渲染前先初始化主题（防闪白，data-theme 已由 index.html 内联脚本先行设置）
initTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
