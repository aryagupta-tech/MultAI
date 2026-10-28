import { app, BrowserWindow, dialog, ipcMain, session, shell, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { IPC, type BuildInfo, type FolderPick } from '../src/bridge/contract';

// Injected by scripts/build-electron.mjs.
declare const __BUILD_INFO__: Omit<BuildInfo, 'platform'>;
declare const __DEV_SERVER_URL__: string;

const isDev = __DEV_SERVER_URL__ !== '';
const rendererIndex = path.join(__dirname, '..', 'renderer', 'index.html');
const rendererUrl = isDev ? __DEV_SERVER_URL__ : pathToFileURL(rendererIndex).toString();

let mainWindow: BrowserWindow | null = null;

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

function registerIpc(): void {
  ipcMain.handle(IPC.buildInfo, (event): BuildInfo => {
    assertTrustedSender(event);
    return { ...__BUILD_INFO__, platform: process.platform as BuildInfo['platform'] };
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
    // The renderer receives a display hint only; the canonical path stays in the main process
    // once project registration is implemented.
    return { canceled: false, name: path.basename(folder), folderHint: displayFolder(folder) };
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
  mainWindow.on('closed', () => (mainWindow = null));
  void mainWindow.loadURL(rendererUrl);
}

app.enableSandbox();
app.whenReady().then(() => {
  hardenSession();
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
