import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type DesktopBridge } from '../src/bridge/contract';

const bridge: DesktopBridge = {
  getBuildInfo: () => ipcRenderer.invoke(IPC.buildInfo),
  pickProjectFolder: () => ipcRenderer.invoke(IPC.pickFolder),
};

contextBridge.exposeInMainWorld('multai', Object.freeze(bridge));
