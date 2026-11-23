const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('native', {
  openFile: (accept) => ipcRenderer.invoke('open-file', accept),
  saveFile: (defName, text, kind) => ipcRenderer.invoke('save-file', defName, text, kind),
  setDirty: (v) => ipcRenderer.send('set-dirty', v),
  onOpenFile: (cb) => ipcRenderer.on('open-file', (e, f) => cb(f)),
  onBeforeClose: (cb) => ipcRenderer.on('before-close', async () => { const ok = await cb(); if (ok) ipcRenderer.send('close-now'); }),
});
