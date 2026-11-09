'use strict';
/* preload.js — 渲染层桥（contextIsolation，只暴露白名单 API） */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('quota', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  refresh: () => ipcRenderer.invoke('data:refresh'),
  onData: (cb) => ipcRenderer.on('data:update', (_e, snap) => cb && cb(snap)),
  onDockState: (cb) => ipcRenderer.on('dock:state', (_e, s) => cb && cb(s)),
  dockHover: (inside) => ipcRenderer.send('dock:hover', !!inside),
  winDrag: (sx, sy) => ipcRenderer.send('win:drag', sx, sy),
  winDragStart: () => ipcRenderer.send('win:drag-start'),
  winDragEnd: () => ipcRenderer.send('win:drag-end'),
  winAction: (act) => ipcRenderer.send('win:action', act),
  openExternal: (url) => ipcRenderer.invoke('ext:open', url),
  /* 当月用量 CSV 导出 */
  exportCsv: () => ipcRenderer.invoke('data:export'),
  /* 跟随系统主题 */
  onSystemTheme: (cb) => ipcRenderer.on('theme:system', (_e, s) => cb && cb(s)),
  /* OTA 在线更新 */
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  getUpdateState: () => ipcRenderer.invoke('update:state'),
  onUpdateState: (cb) => ipcRenderer.on('update:state', (_e, s) => cb && cb(s)),
  version: '1.2.1'
});
