import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type DesktopBridge, type ServiceApi, type ServiceOp } from '../src/bridge/contract';

const call = (op: ServiceOp) => (...args: unknown[]) => ipcRenderer.invoke(IPC.invoke, op, args);

function listen<T>(channel: string) {
  return (listener: (payload: T) => void) => {
    const handler = (_event: IpcRendererEvent, payload: T) => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => { ipcRenderer.removeListener(channel, handler); };
  };
}

const ops: ServiceOp[] = [
  'health', 'authState', 'signIn', 'cancelSignIn', 'signOut', 'listSessions', 'getSession', 'readEvents', 'createSession',
  'postMessage', 'setMode', 'createInvitation', 'joinInvitation', 'listJoinRequests', 'admit', 'revokeParticipant',
  'deleteSession', 'subscribe', 'unsubscribe',
];

const service = {
  ...Object.fromEntries(ops.map((op) => [op, call(op)])),
  onAuthChange: listen(IPC.authChanged),
  onLiveEvents: listen(IPC.liveEvents),
  onLiveStatus: listen(IPC.liveStatus),
  onJoinLink: listen(IPC.joinLink),
} as unknown as ServiceApi;

const bridge: DesktopBridge = {
  getBuildInfo: () => ipcRenderer.invoke(IPC.buildInfo),
  pickProjectFolder: () => ipcRenderer.invoke(IPC.pickFolder),
  service: Object.freeze(service),
};

contextBridge.exposeInMainWorld('multai', Object.freeze(bridge));
