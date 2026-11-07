import { BrowserWindow, Menu, app, clipboard, dialog, ipcMain, nativeImage, net, protocol, session, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, existsSync, promises as fs, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { IMAGE_EXTS, THUMB_EXTS, VIDEO_EXTS, canOpenDirectly, type GuardEnv } from '../shared/protected';
import { buildCsv, buildHtml, buildJson, type ReportData } from '../shared/report';
import {
  DEFAULT_SETTINGS,
  FLAG,
  type AppInfo,
  type CleanupPayload,
  type DeletePlan,
  type DeleteRequest,
  type DupPage,
  type EngineEvent,
  type HistoryEntry,
  type ModelsPayload,
  type NodeInfo,
  type PreviewInfo,
  type QueryPage,
  type ReportFormat,
  type ScanSummary,
  type Settings,
  type StatsPayload,
} from '../shared/types';
import { DeletionService, nodeFileDeps } from './deletion';
import { Engine } from './engine';

const GROUND = '#17171a';
const TEST_MODE = !app.isPackaged && process.env.DISKHUNTER_TEST === '1';
const ALLOWED_COMMANDS = new Set(['ping', 'drives.list', 'scan.start', 'scan.cancel', 'scan.errors', 'scan.summary', 'node.children', 'node.info', 'node.find', 'node.chain', 'treemap', 'query', 'stats', 'cleanup', 'dups.start', 'dups.cancel', 'dups.page', 'models', 'snapshots.list', 'snapshots.compare']);
const LONG_COMMANDS = new Set(['models', 'cleanup', 'query', 'stats']);

if (TEST_MODE && process.env.DISKHUNTER_USER_DATA) app.setPath('userData', process.env.DISKHUNTER_USER_DATA);
if (!app.requestSingleInstanceLock()) app.quit();

protocol.registerSchemesAsPrivileged([{ scheme: 'dhpreview', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

let win: BrowserWindow | null = null;
let engine: Engine;
let deletion: DeletionService;
let isAdmin = false;
let settings: Settings = { ...DEFAULT_SETTINGS };

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const historyFile = () => path.join(app.getPath('userData'), 'history.jsonl');

function send(channel: string, value: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, value);
}

function loadSettings(): void {
  try {
    settings = sanitizeSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(settingsFile(), 'utf8')) });
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}

function sanitizeSettings(value: Partial<Settings>): Settings {
  const clamp = (input: unknown, min: number, max: number, fallback: number) => (typeof input === 'number' && Number.isFinite(input) ? Math.min(max, Math.max(min, Math.round(input))) : fallback);
  return {
    metric: value.metric === 'size' ? 'size' : 'alloc',
    excludes: Array.isArray(value.excludes) ? value.excludes.filter((e): e is string => typeof e === 'string' && e.length > 0 && e.length < 4000).slice(0, 200) : [],
    downloadsDays: clamp(value.downloadsDays, 1, 3650, DEFAULT_SETTINGS.downloadsDays),
    installerDays: clamp(value.installerDays, 1, 3650, DEFAULT_SETTINGS.installerDays),
    dupMinMB: clamp(value.dupMinMB, 0, 102400, DEFAULT_SETTINGS.dupMinMB),
    dupIncludeSystem: value.dupIncludeSystem === true,
  };
}

function guardEnv(): GuardEnv {
  const systemDrive = process.env.SystemDrive ?? 'C:';
  const home = app.getPath('home');
  let realHome = home;
  try {
    realHome = realpathSync(home);
  } catch {
    realHome = home;
  }
  return {
    systemDrive,
    windows: process.env.SystemRoot ?? `${systemDrive}\\Windows`,
    programFiles: [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432, `${systemDrive}\\Program Files`, `${systemDrive}\\Program Files (x86)`, `${systemDrive}\\Program Files (Arm)`].filter((p): p is string => Boolean(p)),
    programData: process.env.ProgramData ?? `${systemDrive}\\ProgramData`,
    users: path.dirname(home),
    otherUsers: [path.dirname(realHome), ...(process.env.PUBLIC ? [path.dirname(process.env.PUBLIC)] : [])],
    userProfile: app.getPath('home'),
    appPaths: [app.getPath('userData'), app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath()],
  };
}

function engineCommand(): { command: string; args: string[] } {
  const dataArgs = ['--data', app.getPath('userData')];
  if (app.isPackaged) return { command: path.join(process.resourcesPath, 'engine', 'diskhunter-engine.exe'), args: dataArgs };
  const root = app.getAppPath();
  const published = path.join(root, 'engine', 'publish', 'diskhunter-engine.exe');
  const release = path.join(root, 'engine', 'DiskHunter.Engine', 'bin', 'Release', 'net8.0', 'win-x64', 'diskhunter-engine.exe');
  const debug = path.join(root, 'engine', 'DiskHunter.Engine', 'bin', 'Debug', 'net8.0', 'win-x64', 'diskhunter-engine.exe');
  const newest = [release, published, debug].find((candidate) => existsSync(candidate));
  if (!newest) throw new Error('Motor não encontrado. Rode npm run build:engine.');
  return { command: newest, args: dataArgs };
}

function startEngine(): void {
  const { command, args } = engineCommand();
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (TEST_MODE) env.DISKHUNTER_TEST = '1';
  else delete env.DISKHUNTER_TEST;
  engine = new Engine(command, args, env, (event: EngineEvent) => send('engine:event', event));
  engine.start();
}

async function describe(id: number): Promise<NodeInfo> {
  if (!Number.isInteger(id)) throw new Error('Item inválido.');
  const [info] = await engine.call<NodeInfo[]>('node.info', { ids: [id] });
  if (!info || info.gone) throw new Error('Este item não está mais na análise.');
  return info;
}

function logHistory(entry: HistoryEntry): void {
  try {
    appendFileSync(historyFile(), `${JSON.stringify(entry)}\n`);
  } catch {
    return;
  }
}

async function readHistory(): Promise<HistoryEntry[]> {
  try {
    const text = await fs.readFile(historyFile(), 'utf8');
    return text.split('\n').filter(Boolean).slice(-500).reverse().flatMap((line) => {
      try {
        return [JSON.parse(line) as HistoryEntry];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

async function buildPreview(id: number): Promise<PreviewInfo> {
  const info = await describe(id);
  if ((info.flags & (FLAG.dir | FLAG.link)) !== 0) return { kind: 'none' };
  if ((info.flags & FLAG.cloud) !== 0) return { kind: 'none', reason: 'Está só na nuvem. Abrir baixaria o arquivo.' };
  const ext = info.ext.toLowerCase();
  const url = `dhpreview://file/${id}`;
  if (IMAGE_EXTS.has(ext)) return { kind: 'image', url };
  if (VIDEO_EXTS.has(ext) || THUMB_EXTS.has(ext)) {
    let thumb: string | undefined;
    try {
      const image = await nativeImage.createThumbnailFromPath(info.path, { width: 640, height: 360 });
      if (!image.isEmpty()) thumb = image.toDataURL();
    } catch {
      thumb = undefined;
    }
    if (VIDEO_EXTS.has(ext)) return { kind: 'video', url, thumb };
    if (thumb) return { kind: 'image', thumb };
    return { kind: 'none', reason: 'O Windows não gerou uma miniatura para este arquivo.' };
  }
  return { kind: 'none' };
}

async function exportReport(format: ReportFormat): Promise<{ path: string } | null> {
  if (!win) return null;
  const summary = await engine.call<ScanSummary | null>('scan.summary');
  if (!summary) throw new Error('Faça uma análise antes de exportar.');
  const stamp = new Date().toISOString().slice(0, 10);
  const defaultName = `diskhunter-${summary.path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()}-${stamp}.${format}`;
  const filters = { html: { name: 'Página HTML', extensions: ['html'] }, csv: { name: 'Planilha CSV', extensions: ['csv'] }, json: { name: 'JSON', extensions: ['json'] } };
  const target = TEST_MODE && process.env.DISKHUNTER_EXPORT_DIR
    ? path.join(process.env.DISKHUNTER_EXPORT_DIR, defaultName)
    : (await dialog.showSaveDialog(win, { defaultPath: defaultName, filters: [filters[format]] })).filePath;
  if (!target) return null;

  const [stats, topFiles, topDirs, cleanup, models, duplicates] = await Promise.all([
    engine.call<StatsPayload>('stats'),
    engine.call<QueryPage>('query', { filter: { kind: 'file', sort: 'size' }, limit: 500 }),
    engine.call<QueryPage>('query', { filter: { kind: 'dir', sort: 'size' }, limit: 200 }),
    engine.call<CleanupPayload>('cleanup', { downloadsDays: settings.downloadsDays, installerDays: settings.installerDays }),
    engine.call<ModelsPayload>('models', {}, undefined, 300000),
    engine.call<DupPage | null>('dups.page', { limit: 500 }),
  ]);
  const data: ReportData = { generatedAt: Math.floor(Date.now() / 1000), summary, stats, topFiles: topFiles.items, topDirs: topDirs.items, cleanup, models, duplicates };
  const body = format === 'csv' ? buildCsv(data) : format === 'json' ? buildJson(data) : buildHtml(data);
  await fs.writeFile(target, body, 'utf8');
  return { path: target };
}

function relaunchAsAdmin(): Promise<{ ok: boolean; reason?: string }> {
  if (!app.isPackaged) return Promise.resolve({ ok: false, reason: 'Disponível só no aplicativo instalado.' });
  return new Promise((resolve) => {
    const exe = app.getPath('exe').replace(/['\u2018\u2019\u201a\u201b]/g, "''");
    app.releaseSingleInstanceLock();
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath '${exe}' -Verb RunAs`], { windowsHide: true }, (error) => {
      if (error) {
        app.requestSingleInstanceLock();
        resolve({ ok: false, reason: 'O Windows não concedeu a permissão.' });
        return;
      }
      resolve({ ok: true });
      app.quit();
    });
  });
}

function registerIpc(): void {
  ipcMain.handle('app:info', (): AppInfo => ({ version: app.getVersion(), isAdmin, isPackaged: app.isPackaged, engineReady: engine.ready, testMode: TEST_MODE }));
  ipcMain.handle('engine:call', (_event, cmd: unknown, args: unknown, slot: unknown) => {
    if (typeof cmd !== 'string' || !ALLOWED_COMMANDS.has(cmd)) throw new Error('Comando não permitido.');
    const payload = args !== null && typeof args === 'object' ? args : {};
    return engine.call(cmd, payload, typeof slot === 'string' ? slot : undefined, LONG_COMMANDS.has(cmd) ? 300000 : 120000);
  });
  ipcMain.handle('dialog:folder', async () => {
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Escolha a pasta para analisar' });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', async (_event, patch: Partial<Settings>) => {
    settings = sanitizeSettings({ ...settings, ...(patch ?? {}) });
    await fs.writeFile(settingsFile(), JSON.stringify(settings, null, 2));
    return settings;
  });
  ipcMain.handle('item:reveal', async (_event, id: number) => {
    shell.showItemInFolder((await describe(id)).path);
  });
  ipcMain.handle('item:revealPath', async (_event, target: unknown) => {
    if (typeof target !== 'string') return false;
    const summary = await engine.call<ScanSummary | null>('scan.summary');
    const known = summary && (await engine.call<number | null>('node.find', { path: target }));
    if (known === null || known === undefined) return false;
    shell.showItemInFolder(target);
    return true;
  });
  ipcMain.handle('item:open', async (_event, id: number) => {
    const info = await describe(id);
    if ((info.flags & FLAG.dir) !== 0) {
      const error = await shell.openPath(info.path);
      return error ? { ok: false, reason: error } : { ok: true };
    }
    if (!canOpenDirectly(info.ext)) {
      shell.showItemInFolder(info.path);
      return { ok: false, reason: 'Por segurança, programas e scripts são mostrados no Explorador em vez de executados.' };
    }
    const error = await shell.openPath(info.path);
    return error ? { ok: false, reason: error } : { ok: true };
  });
  ipcMain.handle('item:copy', async (_event, id: number) => {
    clipboard.writeText((await describe(id)).path);
  });
  ipcMain.handle('item:preview', (_event, id: number) => buildPreview(id));
  ipcMain.handle('delete:plan', (_event, request: DeleteRequest) => {
    if (!request || !Array.isArray(request.ids)) throw new Error('Seleção inválida.');
    return deletion.plan({ ids: request.ids, keep: request.keep, permanent: request.permanent === true });
  });
  ipcMain.handle('delete:run', (_event, token: unknown) => {
    if (typeof token !== 'string') throw new Error('Confirmação inválida.');
    return deletion.run(token, confirmPermanent, (progress) => send('delete:progress', progress));
  });
  ipcMain.handle('delete:cancel', () => deletion.cancel());
  ipcMain.handle('history:list', () => readHistory());
  ipcMain.handle('app:recycle', () => {
    spawn('explorer.exe', ['shell:RecycleBinFolder'], { detached: true, stdio: 'ignore' }).unref();
  });
  ipcMain.handle('report:export', (_event, format: ReportFormat) => {
    if (format !== 'html' && format !== 'csv' && format !== 'json') throw new Error('Formato inválido.');
    return exportReport(format);
  });
  ipcMain.handle('app:admin', () => relaunchAsAdmin());
}

async function confirmPermanent(plan: DeletePlan): Promise<boolean> {
  if (TEST_MODE && process.env.DISKHUNTER_AUTO_CONFIRM === '1') return true;
  if (!win) return false;
  const result = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Excluir permanentemente',
    message: `${plan.allowed} ${plan.allowed === 1 ? 'item será apagado' : 'itens serão apagados'} sem passar pela Lixeira. Não há como recuperar.`,
    detail: plan.entries.filter((entry) => entry.status === 'ok').slice(0, 8).map((entry) => entry.path).join('\n'),
    buttons: ['Cancelar', 'Excluir permanentemente'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return result.response === 1;
}

function registerPreviewProtocol(): void {
  protocol.handle('dhpreview', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'file') return new Response(null, { status: 404 });
      const id = Number(url.pathname.slice(1));
      const info = await describe(id);
      const ext = info.ext.toLowerCase();
      if ((info.flags & (FLAG.dir | FLAG.cloud | FLAG.link)) !== 0 || !(IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext))) return new Response(null, { status: 403 });
      return await net.fetch(pathToFileURL(info.path).toString(), { headers: request.headers, bypassCustomProtocolHandlers: true });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: GROUND,
    show: false,
    title: 'DiskHunter',
    icon: path.join(app.getAppPath(), 'dist', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: GROUND, symbolColor: '#b9bac0', height: 44 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.on('closed', () => {
    win = null;
  });
  void win.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'));
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  loadSettings();
  startEngine();
  deletion = new DeletionService({
    ...nodeFileDeps,
    describe: (ids) => engine.call<NodeInfo[]>('node.info', { ids }),
    verifyDuplicate: (keep, other) => engine.call<boolean>('dups.verify', { keep, other }, undefined, 0),
    trash: (target) => shell.trashItem(target),
    forget: async (ids) => {
      await engine.call('node.remove', { ids });
    },
    log: logHistory,
    guardEnv,
    now: () => Math.floor(Date.now() / 1000),
  });
  registerPreviewProtocol();
  registerIpc();
  execFile('net.exe', ['session'], { windowsHide: true }, (error) => {
    isAdmin = !error;
  });
  createWindow();
});

app.on('window-all-closed', () => {
  engine?.stop();
  app.quit();
});
