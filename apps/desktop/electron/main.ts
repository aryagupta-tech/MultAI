import { app, BrowserWindow, clipboard, dialog, ipcMain, session, shell, powerMonitor, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { IPC, type AuthState, type BuildInfo, type FolderPick } from '../src/bridge/contract';
import { Account } from './service/account';
import { LiveHub } from './service/live';
import { isServiceOp, route } from './service/router';
import {ConnectionManager} from './inference/connections';
import {HostCoordinator} from './inference/coordinator';
import {routeInference,type Editor} from './inference/router';
import {execFile} from 'node:child_process';
import {stat} from 'node:fs/promises';
import {ApprovalBroker} from './inference/approvals';
import {RemoteControlHost,routeController,type TrustedPhone} from './service/remote-control';
import {CONTROLLER_IPC} from '../src/bridge/controller';
import {INFERENCE_IPC} from '../src/bridge/execution';
import {ProjectError,ProjectRegistry,git} from './inference/projects';
import {TerminalHost} from './inference/terminal';
import {McpError,McpHost,newServerId,validServer,type McpServer} from './inference/mcp';
import {SecureConnectionStore} from './inference/secure-store';
import {electronLook} from './inference/look';
import {latestRelease} from './update';

// Injected by scripts/build-electron.mjs.
declare const __BUILD_INFO__: Omit<BuildInfo, 'platform' | 'serviceOrigin'>;
declare const __DEV_SERVER_URL__: string;

// Release builds get their own link scheme, profile and service so they never share state with
// development builds installed on the same machine.
const isRelease = __BUILD_INFO__.channel === 'production';
const PROTOCOL = isRelease ? 'multai' : 'multai-dev';
const RELEASE_SERVICE_ORIGIN = 'https://api.multai.si';
const isDev = __DEV_SERVER_URL__ !== '';
const rendererIndex = path.join(__dirname, '..', 'renderer', 'index.html');
const rendererUrl = isDev ? __DEV_SERVER_URL__ : pathToFileURL(rendererIndex).toString();

/**
 * Release builds talk to the hosted service; development builds to a loopback service. Either may
 * be pointed elsewhere with MULTAI_SERVICE_ORIGIN, but only at a loopback port or an HTTPS origin.
 */
function serviceOrigin(): string {
  const raw = process.env.MULTAI_SERVICE_ORIGIN ?? (isRelease ? RELEASE_SERVICE_ORIGIN : 'http://127.0.0.1:4310');
  const url = new URL(raw);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('MULTAI_SERVICE_ORIGIN must be HTTPS or a loopback HTTP origin.');
  }
  return url.origin;
}

const origin = serviceOrigin();
// Fresh namespace per channel; never import a historical MultAI profile implicitly.
app.setPath('userData',path.join(app.getPath('appData'),isRelease?'dev.multai.desktop':'dev.multai.desktop.development'));
let mainWindow: BrowserWindow | null = null;
let pendingJoinToken: string | null = null;
let joinListenerReady=false;

const send = (channel: string, payload: unknown) => {
  if (mainWindow && !mainWindow.isDestroyed()&&!mainWindow.webContents.isDestroyed()) {
    try{mainWindow.webContents.send(channel,payload);}catch{/* Window closed while delivering. */}
  }
};
let connections:ConnectionManager|undefined;
let coordinator:HostCoordinator|undefined;
let approvals:ApprovalBroker|undefined;
let remote:RemoteControlHost|undefined;
const projects=new ProjectRegistry(()=>path.join(app.getPath('userData'),'projects.json'));
// MCP servers the host adds in Settings, encrypted like AI connections (they often hold tokens).
let mcpStore:SecureConnectionStore<McpServer[]>|undefined;
const mcpServers=()=>(mcpStore??=new SecureConnectionStore<McpServer[]>('mcp-servers:v1',()=>[])).load();
const mcp=new McpHost(mcpServers);
const mcpSettings={
  /** Env values never reach the renderer; it sees their names only. */
  list:async()=>(await mcpServers()).map(server=>({...server,env:Object.fromEntries(Object.keys(server.env).map(key=>[key,'']))})),
  save:async(input:McpServer)=>{
    const servers=await mcpServers();const previous=servers.find(server=>server.id===input.id);
    // An empty value keeps what was saved for that name.
    const env=Object.fromEntries(Object.entries(input.env).map(([key,value])=>[key,value||previous?.env[key]||'']));
    const server=validServer({...input,id:previous?.id??newServerId(),env});
    if(servers.some(item=>item.name===server.name&&item.id!==server.id))throw new McpError('INVALID_SERVER','Another server already has that name.');
    await mcpStore!.save([...servers.filter(item=>item.id!==server.id),server].slice(0,20));
    mcp.stopAll();
    return {...server,env:Object.fromEntries(Object.keys(server.env).map(key=>[key,'']))};
  },
  remove:async(id:string)=>{await mcpStore!.save((await mcpServers()).filter(server=>server.id!==id));mcp.stopAll();return null;},
  test:async(id:string)=>{const server=(await mcpServers()).find(item=>item.id===id);if(!server)throw new McpError('MCP_UNAVAILABLE','That server isn’t saved.');return mcp.test(server,os.homedir());},
};
const terminal=new TerminalHost(event=>send(INFERENCE_IPC.terminal,event));

// Editors the host can open a session's worktree in. Only well-known apps; the folder never reaches the renderer.
const EDITOR_APPS:Record<Exclude<Editor,'finder'>,string>={vscode:'Visual Studio Code.app',cursor:'Cursor.app',zed:'Zed.app'};
async function editorApp(editor:Exclude<Editor,'finder'>):Promise<string|null>{
  for(const folder of ['/Applications',path.join(os.homedir(),'Applications')]){
    const candidate=path.join(folder,EDITOR_APPS[editor]);
    if(await stat(candidate).then(item=>item.isDirectory(),()=>false))return candidate;
  }
  return null;
}
async function editors():Promise<Editor[]>{
  if(process.platform!=='darwin')return ['finder'];
  const found=await Promise.all((Object.keys(EDITOR_APPS) as Exclude<Editor,'finder'>[]).map(async editor=>(await editorApp(editor))?editor:null));
  return [...found.filter((editor):editor is Exclude<Editor,'finder'>=>editor!==null),'finder'];
}
async function openIn(folder:string,editor:Editor):Promise<void>{
  if(editor==='finder'){const failed=await shell.openPath(folder);if(failed)throw new ProjectError('OPEN_FAILED',failed);return;}
  const application=await editorApp(editor);
  if(!application)throw new ProjectError('EDITOR_MISSING','That editor isn’t installed on this computer.');
  await new Promise<void>((resolve,reject)=>execFile('/usr/bin/open',['-a',application,folder],error=>error?reject(new ProjectError('OPEN_FAILED','The editor couldn’t open the folder.')):resolve()));
}
const account = new Account(origin, (state) => {
  if(state.status!=='signed-in'){
    terminal.stopAll();void mcp.stopAll();
    connections?.invalidate();
    approvals?.reset();void coordinator?.invalidate().catch(()=>undefined);
    void remote?.stop().catch(()=>undefined);
  }else void remote?.start().catch(()=>undefined);
  send(IPC.authChanged,state);
}, {callbackScheme: PROTOCOL});
const live = new LiveHub(account, (batch) => send(IPC.liveEvents, batch), (change) => send(IPC.liveStatus, change), {emitPresence: (presence) => send(IPC.livePresence, presence)});

/** Only our own top-level renderer document may call the bridge. */
function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const frame = event.senderFrame;
  const trusted =
    mainWindow !== null &&
    event.sender === mainWindow.webContents &&
    frame !== null &&
    frame === event.sender.mainFrame &&
    (isDev ? new URL(frame.url).origin===new URL(__DEV_SERVER_URL__).origin&&new URL(frame.url).pathname===new URL(__DEV_SERVER_URL__).pathname : frame.url.split(/[?#]/)[0] === rendererUrl);
  if (!trusted) throw new Error('Rejected IPC from an untrusted frame.');
}

function displayFolder(folder: string): string {
  const home = os.homedir();
  return folder.startsWith(home + path.sep) ? '~' + folder.slice(home.length) : folder;
}

/** Handles multai:// (multai-dev:// in development) links: sign-in completion and invitations. */
function handleDeepLink(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return;
  }
  if (url.protocol !== `${PROTOCOL}:`) return;
  if (url.hostname === 'auth' && url.pathname === '/callback') {
    void account.completeSignIn(url).catch(()=>send(IPC.authChanged,{status:'signed-out',error:{code:'sign_in_failed',message:'Sign-in could not be completed. Start again.'}}));
  } else if (url.hostname === 'join') {
    const token = url.searchParams.get('token') ?? '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    // The renderer asks for confirmation; nothing is sent until the person agrees.
    if (mainWindow&&joinListenerReady) send(IPC.joinLink, token);
    else pendingJoinToken = token;
  }
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.clipboard,async(event,text:unknown)=>{
    assertTrustedSender(event);
    if(typeof text!=='string'||Buffer.byteLength(text)>1_000_000)return {ok:false,error:{code:'invalid_request',message:'Clipboard text is too large or invalid.'}};
    try{await clipboard.writeText(text);return {ok:true,value:null};}
    catch{return {ok:false,error:{code:'clipboard_unavailable',message:'Couldn’t copy. Select the text and copy it manually.'}};}
  });
  ipcMain.handle(IPC.joinReady,event=>{
    assertTrustedSender(event);joinListenerReady=true;
    if(pendingJoinToken){const token=pendingJoinToken;pendingJoinToken=null;send(IPC.joinLink,token);}
  });
  ipcMain.handle(IPC.updateCheck, async (event) => {
    assertTrustedSender(event);
    return isRelease ? latestRelease(__BUILD_INFO__.version) : null;
  });
  ipcMain.handle(IPC.buildInfo, (event): BuildInfo => {
    assertTrustedSender(event);
    return { ...__BUILD_INFO__, platform: process.platform as BuildInfo['platform'], serviceOrigin: origin };
  });

  ipcMain.handle(IPC.pickFolder, async (event): Promise<FolderPick> => {
    assertTrustedSender(event);
    if (!mainWindow) return { canceled: true };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a project folder',
      buttonLabel: 'Choose folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    const folder = result.filePaths[0];
    if (result.canceled || !folder) return { canceled: true };
    // The renderer receives an id and a display hint only; the canonical path stays in the main process.
    try {
      const project = await projects.register(folder);
      return { canceled: false, projectId: project.projectId, name: project.name, folderHint: displayFolder(project.root), git: project.git };
    } catch (error) {
      return { canceled: false, projectId: null, name: path.basename(folder), folderHint: displayFolder(folder), problem: error instanceof ProjectError ? error.message : 'That folder couldn’t be opened.' };
    }
  });

  ipcMain.handle(IPC.invoke, async (event, op: unknown, args: unknown) => {
    assertTrustedSender(event);
    if (!isServiceOp(op)) throw new Error('Unknown service operation.');
    if(op==='signOut'){
      connections?.invalidate();terminal.stopAll();mcp.stopAll();
      approvals?.reset();await coordinator?.invalidate();
    }
    const generation=account.accountGeneration;
    const result = await route(account, live, op, args);
    if(op==='authState')remote?.recover(result as AuthState,generation);
    if(op==='createSession'&&coordinator){
      const created=result as {ok?:boolean;value?:{session?:{id?:string}}};
      const id=created.ok?created.value?.session?.id:undefined;
      if(id){try{await coordinator.prepareWorkspace(id);}catch{return {ok:false,error:{code:'workspace_unavailable',message:'The session was saved but its private workspace could not be prepared. Retry with the saved draft identity.'}};}}
    }
    if (op === 'authState' && joinListenerReady && pendingJoinToken) {
      // Deliver a join link that launched the app once the renderer is listening.
      const token = pendingJoinToken;
      pendingJoinToken = null;
      setTimeout(() => send(IPC.joinLink, token), 0);
    }
    return result;
  });
  ipcMain.handle(INFERENCE_IPC.invoke,async(event,op:unknown,args:unknown)=>{
    assertTrustedSender(event);
    if(!connections||!coordinator||!approvals)return {ok:false,error:{code:'not_ready',message:'Desktop inference is starting.'}};
    return routeInference(connections,coordinator,approvals,op,args,{projects,terminal,editors,openIn,mcp:mcpSettings});
  });
  ipcMain.handle(CONTROLLER_IPC.invoke,async(event,op:unknown,args:unknown)=>{
    assertTrustedSender(event);
    if(!remote)return {ok:false,error:{code:'not_ready',message:'The desktop is starting.'}};
    return routeController(remote,op,args);
  });
}

function hardenSession(): void {
  // Only the microphone, only for the app's own window (voice instructions). Everything else is refused.
  const ownWindow = (contents: Electron.WebContents | null) => Boolean(contents && mainWindow && !mainWindow.isDestroyed() && contents === mainWindow.webContents);
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
    callback(permission === 'media' && ownWindow(contents) && types.length > 0 && types.every((type) => type === 'audio'));
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => permission === 'media' && ownWindow(contents) && (details as { mediaType?: string }).mediaType === 'audio');
  session.defaultSession.on('will-download', (event) => event.preventDefault());
}

function createWindow(): void {
  const mac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 760,
    minHeight: 520,
    show: false,
    backgroundColor: '#000000',
    title: 'MultAI',
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    ...(mac ? { trafficLightPosition: { x: 16, y: 15 } } : { titleBarOverlay: { color: '#000000', symbolColor: '#a1a1aa', height: 44 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: true,
      devTools: isDev,
    },
  });

  const wc = mainWindow.webContents;
  joinListenerReady=false;
  wc.on('did-start-loading',()=>{joinListenerReady=false;});
  wc.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    if (url !== wc.getURL()) event.preventDefault();
  });
  wc.on('will-attach-webview', (event) => event.preventDefault());

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    joinListenerReady=false;
    mainWindow = null;
    live.closeAll();
    connections?.invalidate();
    approvals?.rejectAll();void coordinator?.invalidate().catch(()=>undefined);
  });
  void mainWindow.loadURL(rendererUrl);
}

// One instance owns the protocol and the credentials file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (process.defaultApp) {
    // Unpackaged dev runs: register `electron <app>` as the handler.
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1] ?? '.')]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }

  app.on('second-instance', (_event, argv) => {
    const link = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (link) handleDeepLink(link);
    else if (mainWindow) mainWindow.focus();
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  app.enableSandbox();
  app.whenReady().then(() => {
    connections=new ConnectionManager({account,onChange:(items)=>send(INFERENCE_IPC.connections,items)});
    let approvalSessions:string[]=[];
    approvals=new ApprovalBroker(pending=>{
      send(INFERENCE_IPC.approvals,pending);
      // A paired phone hears about approvals appearing and disappearing in its sessions.
      const current=pending.map(item=>item.sessionId);remote?.approvalsChanged([...approvalSessions,...current]);approvalSessions=current;
    });
    // Approvals appear as cards in the session; the host's access level decides what runs unasked.
    coordinator=new HostCoordinator({account,connections,projects,mcp,look:electronLook(),dataDirectory:()=>app.getPath('userData'),emit:change=>{send(INFERENCE_IPC.run,change);remote?.runChanged(change);},
      confirm:(descriptor,hash,signal,preview)=>!mainWindow||mainWindow.isDestroyed()?Promise.resolve(false):approvals!.request(descriptor,signal,preview,hash)});
    // Paired phones: this computer keeps the phone keys it confirmed, OS-encrypted per account and device.
    remote=new RemoteControlHost({request:(method,url,body)=>account.request(method,url,body),accountGeneration:()=>account.accountGeneration,
      trust:key=>new SecureConnectionStore<TrustedPhone[]>(`controller-trust:v1:${key}`,()=>[]),identity:()=>account.identitySnapshot(),
      coordinator,approvals,onChange:()=>send(CONTROLLER_IPC.changed,null)});
    void account.state().then(state=>{if(state.status==='signed-in')void remote?.start().catch(()=>undefined);}).catch(()=>undefined);
    powerMonitor.on('suspend',()=>{void remote?.suspend().catch(()=>undefined);connections?.invalidate();live.suspend();approvals?.rejectAll();void coordinator?.invalidate().catch(()=>undefined);void account.suspend().catch(()=>undefined);});
    powerMonitor.on('resume',()=>{void remote?.resume().catch(()=>undefined);});
    // Forget worktrees whose folders are gone (deleted by hand, or left by a crash).
    void projects.all().then(list=>Promise.all(list.map(project=>git(project.root,['worktree','prune'],{allowFail:true}).catch(()=>undefined)))).catch(()=>undefined);
    hardenSession();
    registerIpc();
    createWindow();
    const link = process.argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (link) handleDeepLink(link);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch(()=>{dialog.showErrorBox('MultAI could not start','MultAI could not open its local storage. Quit and open it again. No inference was started.');app.quit();});

  let quitting=false;
  app.on('before-quit', event => {
    if(quitting)return;
    event.preventDefault();quitting=true;
    live.closeAll();connections?.invalidate();terminal.stopAll();mcp.stopAll();
    void remote?.stop().catch(()=>undefined);
    void (coordinator?.invalidate()??Promise.resolve()).catch(()=>undefined).finally(()=>app.quit());
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
