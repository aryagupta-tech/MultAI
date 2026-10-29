import { app, BrowserWindow, dialog, ipcMain, session, shell, powerMonitor, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { IPC, type BuildInfo, type FolderPick } from '../src/bridge/contract';
import { Account } from './service/account';
import { LiveHub } from './service/live';
import { isServiceOp, route } from './service/router';
import {ConnectionManager} from './inference/connections';
import {HostCoordinator} from './inference/coordinator';
import {routeInference} from './inference/router';
import {INFERENCE_IPC} from '../src/bridge/execution';

// Injected by scripts/build-electron.mjs.
declare const __BUILD_INFO__: Omit<BuildInfo, 'platform' | 'serviceOrigin'>;
declare const __DEV_SERVER_URL__: string;

const PROTOCOL = 'multai-dev';
const isDev = __DEV_SERVER_URL__ !== '';
const rendererIndex = path.join(__dirname, '..', 'renderer', 'index.html');
const rendererUrl = isDev ? __DEV_SERVER_URL__ : pathToFileURL(rendererIndex).toString();

/**
 * Development builds talk to a loopback service by default. MULTAI_SERVICE_ORIGIN may point at
 * another loopback port or an HTTPS origin; anything else is refused.
 */
function serviceOrigin(): string {
  const raw = process.env.MULTAI_SERVICE_ORIGIN ?? 'http://127.0.0.1:4310';
  const url = new URL(raw);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('MULTAI_SERVICE_ORIGIN must be HTTPS or a loopback HTTP origin.');
  }
  return url.origin;
}

const origin = serviceOrigin();
// Fresh development namespace; never import a historical MultAI profile implicitly.
app.setPath('userData',path.join(app.getPath('appData'),'dev.multai.desktop.development'));
let mainWindow: BrowserWindow | null = null;
let pendingJoinToken: string | null = null;

const send = (channel: string, payload: unknown) => {
  if (mainWindow && !mainWindow.isDestroyed()&&!mainWindow.webContents.isDestroyed()) {
    try{mainWindow.webContents.send(channel,payload);}catch{/* Window closed while delivering. */}
  }
};
let connections:ConnectionManager|undefined;
let coordinator:HostCoordinator|undefined;
const account = new Account(origin, (state) => {
  if(state.status!=='signed-in'){
    connections?.invalidate();
    void coordinator?.invalidate().catch(()=>undefined);
  }
  send(IPC.authChanged,state);
});
const live = new LiveHub(account, (batch) => send(IPC.liveEvents, batch), (change) => send(IPC.liveStatus, change));

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

/** Handles multai-dev:// links: sign-in completion and invitation links. */
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
    if (!/^[A-Za-z0-9_-]{16,200}$/.test(token)) return;
    // The renderer asks for confirmation; nothing is sent until the person agrees.
    if (mainWindow) send(IPC.joinLink, token);
    else pendingJoinToken = token;
  }
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
}

function registerIpc(): void {
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
    // The renderer receives a display hint only; the canonical path stays in the main process.
    return { canceled: false, name: path.basename(folder), folderHint: displayFolder(folder) };
  });

  ipcMain.handle(IPC.invoke, async (event, op: unknown, args: unknown) => {
    assertTrustedSender(event);
    if (!isServiceOp(op)) throw new Error('Unknown service operation.');
    if(op==='signOut'){
      connections?.invalidate();
      await coordinator?.invalidate();
    }
    const result = await route(account, live, op, args);
    if(op==='createSession'&&coordinator){
      const created=result as {ok?:boolean;value?:{session?:{id?:string}}};
      const id=created.ok?created.value?.session?.id:undefined;
      if(id){try{await coordinator.prepareWorkspace(id);}catch{return {ok:false,error:{code:'workspace_unavailable',message:'The session was saved but its private workspace could not be prepared. Retry with the saved draft identity.'}};}}
    }
    if (op === 'authState' && pendingJoinToken) {
      // Deliver a join link that launched the app once the renderer is listening.
      const token = pendingJoinToken;
      pendingJoinToken = null;
      setTimeout(() => send(IPC.joinLink, token), 0);
    }
    return result;
  });
  ipcMain.handle(INFERENCE_IPC.invoke,async(event,op:unknown,args:unknown)=>{
    assertTrustedSender(event);
    if(!connections||!coordinator)return {ok:false,error:{code:'not_ready',message:'Desktop inference is starting.'}};
    return routeInference(connections,coordinator,op,args);
  });
}

function hardenSession(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
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
    mainWindow = null;
    live.closeAll();
    connections?.invalidate();
    void coordinator?.invalidate().catch(()=>undefined);
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
    coordinator=new HostCoordinator({account,connections,dataDirectory:()=>app.getPath('userData'),emit:change=>send(INFERENCE_IPC.run,change),confirm:async(descriptor,hash,signal,preview)=>{
      if(!mainWindow||mainWindow.isDestroyed())return false;
      const operation=descriptor.operation;
      const detail=operation.kind==='shell'?`Executable: ${operation.executable}\nArguments: ${JSON.stringify(operation.argv)}\nCommand text: ${operation.commandText??'(none)'}`:operation.kind==='file_write'?`File: ${operation.relativePath}\nExpected content: ${operation.expectedContentHash??'(new file)'}\nNew content SHA-256: ${operation.contentHash}\n\nComplete proposed file content:\n${preview??'(preview unavailable; reject this request)'}`:JSON.stringify(operation,null,2);
      if(operation.kind==='file_write'&&preview===undefined)return false;
      const result=await dialog.showMessageBox(mainWindow,{type:'question',title:'Approve this exact action once?',message:operation.kind==='shell'?'Run this command as your OS user?':'Apply this exact workspace change?',detail:`${detail}\n\nWorking directory: ${descriptor.cwd}\nConnection: ${descriptor.connectionId}\nSession: ${descriptor.sessionId}\nExpires: ${new Date(descriptor.expiresAt).toISOString()}\nSHA-256: ${hash}\n\nThis approval is not an operating-system sandbox.`,buttons:['Reject','Approve once'],defaultId:0,cancelId:0,noLink:true,signal});
      return result.response===1&&!signal.aborted;
    }});
    powerMonitor.on('suspend',()=>{connections?.invalidate();live.closeAll();void coordinator?.invalidate().catch(()=>undefined);void account.cancelSignIn().catch(()=>undefined);});
    hardenSession();
    registerIpc();
    createWindow();
    const link = process.argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (link) handleDeepLink(link);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch(()=>{dialog.showErrorBox('MultAI could not start','Check the local application storage and development build. No inference was started.');app.quit();});

  let quitting=false;
  app.on('before-quit', event => {
    if(quitting)return;
    event.preventDefault();quitting=true;
    live.closeAll();connections?.invalidate();
    void (coordinator?.invalidate()??Promise.resolve()).catch(()=>undefined).finally(()=>app.quit());
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
