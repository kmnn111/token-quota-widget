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
  version: '0.1.0'
});
