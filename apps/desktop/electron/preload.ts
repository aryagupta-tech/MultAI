import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type DesktopBridge, type ServiceApi, type ServiceOp } from '../src/bridge/contract';
import {INFERENCE_IPC} from '../src/bridge/execution';

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
  'deleteSession', 'saveDecision', 'subscribe', 'unsubscribe',
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
  inference:Object.freeze({
    list:()=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'list',[]),
    add:(input)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'add',[input]),
    remove:(id)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'remove',[id]),
    models:(id)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'models',[id]),
    connectChatGPT:(id)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'connectChatGPT',[id]),
    cancelChatGPT:()=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'cancelChatGPT',[]),
    manageChatGPTUsage:()=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'manageChatGPTUsage',[]),
    acknowledgeChatGPTPlan:(id)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'acknowledgeChatGPTPlan',[id]),
    select:(input)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'select',[input]),
    selection:()=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'selection',[]),
    run:(input)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'run',[input]),
    stop:(id)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'stop',[id]),
    onConnectionsChange:listen(INFERENCE_IPC.connections),
    onRunChange:listen(INFERENCE_IPC.run),
  } as DesktopBridge['inference']),
};

contextBridge.exposeInMainWorld('multai', Object.freeze(bridge));
