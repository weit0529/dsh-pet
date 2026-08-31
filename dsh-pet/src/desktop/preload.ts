import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('dshPetDesktop', {
  runtime: () => ipcRenderer.invoke('dsh-pet:runtime'),
  request: (kind: string, sessionId?: string) => ipcRenderer.invoke('dsh-pet:request', { kind, sessionId }),
  metrics: () => ipcRenderer.invoke('dsh-pet:window-metrics'),
  setInteractive: (interactive: boolean) => ipcRenderer.send('dsh-pet:set-interactive', interactive),
  setWindowPosition: (x: number, y: number) => ipcRenderer.send('dsh-pet:set-window-position', { x, y }),
  ready: () => ipcRenderer.send('dsh-pet:renderer-ready'),
});
