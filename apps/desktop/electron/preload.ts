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
  'deleteSession', 'saveDecision', 'subscribe', 'unsubscribe', 'sendPresence', 'createReplay', 'listReplays', 'revokeReplay',
  'steerInstruction', 'removeInstruction',
];

const service = {
  ...Object.fromEntries(ops.map((op) => [op, call(op)])),
  onAuthChange: listen(IPC.authChanged),
  onLiveEvents: listen(IPC.liveEvents),
  onLiveStatus: listen(IPC.liveStatus),
  onLivePresence: listen(IPC.livePresence),
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
    brief:(input)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'brief',[input]),
    decide:(id,approved)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'decide',[id,approved]),
    setAccess:(sessionId,level)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'setAccess',[sessionId,level]),
    approvals:()=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'approvals',[]),
    onApprovals:listen(INFERENCE_IPC.approvals),
    startWork:(sessionId,projectId,carry,title)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'startWork',[sessionId,projectId,carry,title]),
    projectStatus:(projectId)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'projectStatus',[projectId]),
    workSummary:(sessionId)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'workSummary',[sessionId]),
    workDiff:(sessionId)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'workDiff',[sessionId]),
    workRevert:(sessionId,file)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'workRevert',[sessionId,file]),
    workKeep:(sessionId,message)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'workKeep',[sessionId,message]),
    workApply:(sessionId)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'workApply',[sessionId]),
    workDiscard:(sessionId)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'workDiscard',[sessionId]),
    draftPullRequest:(input)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'draftPullRequest',[input]),
    workPush:(sessionId,pr)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'workPush',[sessionId,pr]),
    terminalRun:(sessionId,command)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'terminalRun',[sessionId,command]),
    terminalStop:(sessionId)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'terminalStop',[sessionId]),
    onTerminal:listen(INFERENCE_IPC.terminal),
    listFiles:(sessionId,projectId)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'listFiles',[sessionId,projectId]),
    skills:(sessionId,projectId)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'skills',[sessionId,projectId]),
    saveSkill:(input)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'saveSkill',[input]),
    deleteSkill:(name)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'deleteSkill',[name]),
    compact:(input)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'compact',[input]),
    contextUsage:(sessionId)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'contextUsage',[sessionId]),
    undoPreview:(sessionId)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'undoPreview',[sessionId]),
    undo:(sessionId)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'undo',[sessionId]),
    editors:()=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'editors',[]),
    mcpServers:()=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'mcpServers',[]),
    mcpSave:(server)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'mcpSave',[server]),
    mcpDelete:(id)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'mcpDelete',[id]),
    mcpTest:(id)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'mcpTest',[id]),
    lockedActions:(sessionId)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'lockedActions',[sessionId]),
    resolveLocked:(sessionId,actionId,outcome)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'resolveLocked',[sessionId,actionId,outcome]),
    openIn:(sessionId,editor)=>ipcRenderer.invoke(INFERENCE_IPC.invoke,'openIn',[sessionId,editor]),
    onConnectionsChange:listen(INFERENCE_IPC.connections),
    onRunChange:listen(INFERENCE_IPC.run),
  } as DesktopBridge['inference']),
};

contextBridge.exposeInMainWorld('multai', Object.freeze(bridge));
