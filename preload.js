const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  saveFile: (filePath, buffer) => ipcRenderer.invoke('save-file', { filePath, buffer }),
  getAutoInput: () => ipcRenderer.invoke('get-auto-input'),
  readLocalFile: (filePath) => ipcRenderer.invoke('read-local-file', filePath)
});
