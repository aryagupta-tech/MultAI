import { app, BrowserWindow, dialog, ipcMain, session, shell, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { IPC, type BuildInfo, type FolderPick } from '../src/bridge/contract';
import { Account } from './service/account';
import { LiveHub } from './service/live';
import { isServiceOp, route } from './service/router';

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
let mainWindow: BrowserWindow | null = null;
let pendingJoinToken: string | null = null;

const send = (channel: string, payload: unknown) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
};
const account = new Account(origin, (state) => send(IPC.authChanged, state));
const live = new LiveHub(account, (batch) => send(IPC.liveEvents, batch), (change) => send(IPC.liveStatus, change));

/** Only our own top-level renderer document may call the bridge. */
function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const frame = event.senderFrame;
  const trusted =
    mainWindow !== null &&
    event.sender === mainWindow.webContents &&
    frame !== null &&
    frame === event.sender.mainFrame &&
    (isDev ? frame.url.startsWith(__DEV_SERVER_URL__) : frame.url.split(/[?#]/)[0] === rendererUrl);
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
    void account.completeSignIn(url);
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
    const result = await route(account, live, op, args);
    if (op === 'authState' && pendingJoinToken) {
      // Deliver a join link that launched the app once the renderer is listening.
      const token = pendingJoinToken;
      pendingJoinToken = null;
      setTimeout(() => send(IPC.joinLink, token), 0);
    }
    return result;
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
    hardenSession();
    registerIpc();
    createWindow();
    const link = process.argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (link) handleDeepLink(link);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => live.closeAll());
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
