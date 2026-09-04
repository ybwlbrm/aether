import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles/globals.css';
import 'streamdown/styles.css';
import { injectActivityStyles } from './components/activity/ActivityStream';
import { initAuthToken } from './api/client';
injectActivityStyles();

// 初始化本地认证 token（异步不阻塞渲染，失败由敏感端点 401 处理）
initAuthToken();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);