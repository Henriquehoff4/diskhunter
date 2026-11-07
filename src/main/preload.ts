import { contextBridge, ipcRenderer } from 'electron';
import type { DeleteProgress, DiskHunterApi, EngineEvent } from '../shared/types';

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: unknown, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: DiskHunterApi = {
  info: () => ipcRenderer.invoke('app:info'),
  call: (cmd, args, slot) => ipcRenderer.invoke('engine:call', cmd, args, slot),
  onEvent: (listener) => subscribe<EngineEvent>('engine:event', listener),
  pickFolder: () => ipcRenderer.invoke('dialog:folder'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  reveal: (id) => ipcRenderer.invoke('item:reveal', id),
  revealPath: (path) => ipcRenderer.invoke('item:revealPath', path),
  open: (id) => ipcRenderer.invoke('item:open', id),
  copyPath: (id) => ipcRenderer.invoke('item:copy', id),
  preview: (id) => ipcRenderer.invoke('item:preview', id),
  planDelete: (request) => ipcRenderer.invoke('delete:plan', request),
  runDelete: (token) => ipcRenderer.invoke('delete:run', token),
  cancelDelete: () => ipcRenderer.invoke('delete:cancel'),
  onDeleteProgress: (listener) => subscribe<DeleteProgress>('delete:progress', listener),
  history: () => ipcRenderer.invoke('history:list'),
  openRecycleBin: () => ipcRenderer.invoke('app:recycle'),
  exportReport: (format) => ipcRenderer.invoke('report:export', format),
  relaunchAsAdmin: () => ipcRenderer.invoke('app:admin'),
};

contextBridge.exposeInMainWorld('diskhunter', api);
