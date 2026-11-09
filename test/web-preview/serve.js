'use strict';
/**
 * 浏览器预览服务器：加载真实渲染层 + mock 的 window.smcl。
 * 用途：在没有 Chromium 桌面环境的沙箱里做 UI 视觉自检（node serve.js 后浏览器访问）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const renderer = path.join(root, 'renderer');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

const settings = {
  mcDir: 'D:\\mock\\.minecraft',
  extraDirs: [],
  javaPath: '',
  memory: 4096,
  downloadSource: 'bmcl',
  downloadThreads: 8,
  playerName: 'Steve',
  jvmArgs: '',
  fullscreen: false,
  resolution: { enabled: false, width: 925, height: 530 },
  autoCheck: true,
  autoUpdateCheck: true,
  gpuFallback: false,
  theme: 'dark',
  accent: 'brand',
  wallpaper: { enabled: false, image: '', fit: 'cover', mask: 'soft', opacity: 0.6, blur: 0, dim: 0.35, ui: 0.78 },
  saveGroup: 'folder',
  cfApiKey: '',
  msClientId: '',
  loginMode: 'offline',
  lastSeenVersion: '',
  gpuHighPerf: false,
};

const installed = [
  { id: '1.21.2', dir: 'D:\\mock\\.minecraft', dirName: '主目录', kind: 'primary', type: 'release', mainClass: '', javaMajor: 21, mcVersion: '1.21.2', inheritsFrom: '', loader: '原版', hasJar: true, isolated: false, mods: 0, size: 512 * 1048576, updatedAt: Date.now() },
  { id: 'fabric-loader-0.16.9-1.21.1', dir: 'D:\\mock\\.minecraft', dirName: '主目录', kind: 'primary', type: 'release', mainClass: '', javaMajor: 21, mcVersion: '1.21.1', inheritsFrom: '1.21.1', loader: 'Fabric', hasJar: true, isolated: true, mods: 12, size: 1331 * 1048576, updatedAt: Date.now() - 86400000 },
  { id: 'Forge 1.20.1', dir: 'E:\\PCL\\.minecraft', dirName: 'PCL', kind: 'PCL', type: 'release', mainClass: '', javaMajor: 17, mcVersion: '1.20.1', inheritsFrom: '1.20.1', loader: 'Forge', hasJar: false, isolated: true, mods: 48, size: 2200 * 1048576, updatedAt: Date.now() - 3 * 86400000 },
  { id: 'NeoForge 1.21.3', dir: 'E:\\PCL\\.minecraft', dirName: 'PCL', kind: 'PCL', type: 'release', mainClass: '', javaMajor: 21, mcVersion: '1.21.3', inheritsFrom: '1.21.3', loader: 'NeoForge', hasJar: true, isolated: true, mods: 31, size: 3 * 1073741824, updatedAt: Date.now() - 5 * 86400000 },
  { id: '1.8.9', dir: 'D:\\mock\\.minecraft', dirName: '主目录', kind: 'primary', type: 'release', mainClass: '', javaMajor: 8, mcVersion: '1.8.9', inheritsFrom: '', loader: '原版', hasJar: true, isolated: false, mods: 0, size: 380 * 1048576, updatedAt: Date.now() - 30 * 86400000 },
];

const saves = [
  { path: 'D:\\mock\\.minecraft\\saves\\SWUST Campus', folderName: 'SWUST Campus', name: '龙山校区·梦幻复原', version: '1.21.2', gameType: '创造', difficulty: '和平', hardcore: false, wasModded: false, seed: 42424242, lastPlayed: Date.now() - 3600000, size: 890 * 1048576, icon: 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="40"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7ec8f5"/><stop offset="1" stop-color="#3a9d4f"/></linearGradient></defs><rect width="64" height="40" fill="url(%23g)"/><rect x="8" y="18" width="14" height="16" fill="#c46a4a"/><rect x="30" y="10" width="20" height="24" fill="#e8e8e8"/><rect x="36" y="14" width="8" height="8" fill="#7ab0ff"/></svg>').toString('base64'), broken: false, dir: 'D:\\mock\\.minecraft', dirName: '主目录', instanceId: null },
  { path: 'D:\\mock\\...\\saves\\生存季', folderName: '生存季', name: '与室友的生存季', version: '1.21.1', gameType: '生存', difficulty: '普通', hardcore: false, wasModded: true, seed: 1, lastPlayed: Date.now() - 26 * 3600000, size: 1.2 * 1073741824, icon: null, broken: false, dir: 'D:\\mock\\.minecraft', dirName: '主目录', instanceId: 'fabric-loader-0.16.9-1.21.1' },
  { path: 'E:\\PCL\\...\\saves\\极限挑战', folderName: '极限挑战', name: '§c极限挑战', version: '1.20.1', gameType: '生存', difficulty: '困难', hardcore: true, wasModded: true, seed: 999, lastPlayed: Date.now() - 4 * 86400000, size: 640 * 1048576, icon: null, broken: false, dir: 'E:\\PCL\\.minecraft', dirName: 'PCL', instanceId: 'Forge 1.20.1' },
];

const manifestVersions = [];
const now = Date.UTC(2026, 9, 20);
for (let i = 0; i < 40; i++) {
  manifestVersions.push({ id: `1.21.${10 - i}`, type: 'release', releaseTime: new Date(now - i * 30 * 86400000).toISOString(), url: `https://piston-meta.mojang.com/v1/packages/x/${i}.json` });
}
for (let i = 0; i < 12; i++) manifestVersions.push({ id: `26w${String(10 - i).padStart(2, '0')}a`, type: 'snapshot', releaseTime: new Date(now - i * 7 * 86400000).toISOString(), url: `https://piston-meta.mojang.com/v1/packages/x/s${i}.json` });
for (let i = 0; i < 10; i++) manifestVersions.push({ id: `b1.7.${3 - (i % 4)}`, type: 'old_beta', releaseTime: new Date(now - 5000 * 86400000).toISOString(), url: `https://piston-meta.mojang.com/v1/packages/x/b${i}.json` });

const modrinthHits = [
  { projectId: 'a', slug: 'sodium', title: 'Sodium', description: '现代渲染优化模组，大幅提升帧率', author: 'jellysquid3', downloads: 4200000, follows: 12000, iconUrl: '', dateModified: '', versions: ['1.21.2', '1.21.1'], categories: ['optimization', 'fabric'] },
  { projectId: 'b', slug: 'fabric-api', title: 'Fabric API', description: 'Fabric 模组生态的核心前置库，几乎所有 Fabric 模组都依赖', author: 'modmuss50', downloads: 8900000, follows: 9000, iconUrl: '', versions: ['1.21.2'], categories: ['library'] },
  { projectId: 'c', slug: 'swwu', title: 'Sodium Extra', description: 'Sodium 的补充选项', author: 'FlashyReese', downloads: 1200000, follows: 3000, iconUrl: '', versions: ['1.21.2'], categories: ['optimization'] },
  { projectId: 'd', slug: 'litematica', title: 'Litematica', description: '原理图模组', author: 'masa', downloads: 2000000, follows: 5000, iconUrl: '', versions: ['1.21.1'], categories: ['utility'] },
  { projectId: 'e', slug: 'complementary', title: 'Complementary Shaders', description: '高口碑光影', author: 'EminGT', downloads: 3200000, follows: 8000, iconUrl: '', versions: ['1.21.2'], categories: ['shaders'] },
  { projectId: 'f', slug: 'distant', title: 'Distant Horizons', description: '超远视距渲染', author: 'James Seibel', downloads: 2300000, follows: 7600, iconUrl: '', versions: ['1.21.2'], categories: ['performance'] },
];

const javaList = [
  { path: 'C:\\Program Files\\Java\\jdk-21\\bin\\javaw.exe', java: 'C:\\Program Files\\Java\\jdk-21\\bin\\java.exe', source: '安装目录', version: '21.0.5', major: 21, bits: 64, vendor: 'OpenJDK' },
  { path: 'C:\\Program Files\\Eclipse Adoptium\\jdk-17\\bin\\javaw.exe', java: '', source: '安装目录', version: '17.0.12', major: 17, bits: 64, vendor: 'OpenJDK' },
  { path: 'C:\\Program Files\\Java\\jre1.8\\bin\\javaw.exe', java: '', source: 'PATH', version: '1.8.0_421', major: 8, bits: 64, vendor: 'Oracle' },
];

let taskMapMock = {"安装 26.3":{"name":"安装 26.3","source":"Minecraft","status":"done","percent":100,"message":"完成","start":1794054048962,"end":1794054108962},"下载资源":{"name":"下载资源","source":"Modrinth","status":"running","percent":42,"message":"下载中 10/24 · 850 KB/s","start":1794054123962}};
let gameRunning = false;

const mock = {
  version: '1.0.0-mock',
  state: async () => ({
    cfReady: true,
    settings, account: { mode: 'offline', name: 'Steve', uuid: 'mock-uuid', skinUrl: '' },
    dirs: [
      { path: 'D:\\mock\\.minecraft', kind: 'primary', name: '主目录', instances: 3 },
      { path: 'E:\\PCL\\.minecraft', kind: 'PCL', name: 'PCL', instances: 2 },
      { path: 'C:\\Users\\demo\\AppData\\Roaming\\.minecraft', kind: 'official', name: '官方启动器', instances: 0 },
    ],
    gameRunning, taskMap: taskMapMock, latestRelease: '1.21.10', version: '1.0.0', gpuFallback: false, sysMemory: 16 * 1073741824,
  }),
  win: { minimize() {}, maximize() {}, close() {} },
  save: async (patch) => { Object.assign(settings, patch.wallpaper ? { wallpaper: { ...settings.wallpaper, ...patch.wallpaper } } : patch); return settings; },
  onSettingsChanged: () => () => {},
  dirs: async () => [],
  addDir: async () => null,
  removeDir: async () => [],
  detectJava: async () => javaList,
  manifest: async () => ({ latest: { release: '1.21.10' }, source: 'race', versions: manifestVersions }),
  installed: async () => installed,
  sizes: async () => true,
  onVersionSize: () => () => {},
  deleteVersion: async () => ({ ok: true }),
  versionCommand: async () => 'javaw -Xmx4096M -cp ... net.minecraft.client.main.Main --username Steve',
  install: async (id) => { for (let p = 0; p <= 100; p += 10) { emit('install:progress', { id, stage: 'download', message: `下载中 ${p}/100`, percent: p }); await sleep(300); } return { ok: true, id, files: 210, skipped: 180, bytes: 22 * 1048576, warnings: [] }; },
  onInstall: () => () => {},
  repair: async () => ({ ok: true, fixed: 0, remaining: [] }),
  launch: async (id) => { gameRunning = true; return { ok: true, pid: 1234, isolated: true }; },
  kill: async () => { gameRunning = false; return { ok: true }; },
  copyCommand: async () => true,
  openLogFile: async () => true,
  onGameStarted: () => () => {},
  onGameExit: () => () => {},
  onGameError: () => () => {},
  saves: async () => saves,
  onSavesProgress: () => () => {},
  revealSave: async () => true,
  trashSave: async () => ({ ok: true }),
  listLoaders: async (loader, mc) => (loader === 'fabric' || loader === 'quilt')
    ? [0.1, 1, 2, 3, 4, 5].map((i) => ({ version: `0.16.${9 - i}`, stable: i > 0 }))
    : ['51.1.0', '51.0.33', '50.1.0'].map((v) => ({ version: v, stable: true })),
  installLoader: async () => ({ ok: true, id: 'fabric-1.21.2' }),
  onLoader: () => () => {},
  pickPack: async () => null,
  inspectPack: async () => ({ format: 'modrinth', name: '星启真实整合包', version: '1.0', author: 'SWUST MC 社团', description: '一个用于测试的整合包预览', mcVersion: '1.21.2', loader: 'Fabric', loaderVersion: '0.16.9', modCount: 87, files: [], overridesDir: 'overrides', entryCount: 120 }),
  installPack: async () => ({ id: '星启真实整合包', warnings: [], dependencies: { ok: true, missing: 0 } }),
  onPack: () => () => {},
  exportPlan: async () => ({ id: '1.21.2', files: [{ path: 'mods/a.jar', size: 1048576 }], totalBytes: 42 * 1048576, loader: 'fabric', loaderVersion: '0.16.9', mcVersion: '1.21.2' }),
  exportPick: async () => null,
  exportPack: async () => ({ count: 1 }),
  onExportProgress: () => () => {},
  contentSearch: async (q) => ({ source: q.source, total: modrinthHits.length, hits: modrinthHits }),
  contentVersions: async () => [
    { id: 'v1', name: 'Sodium 0.6.3', versionNumber: '0.6.3+mc1.21.2', date: '', gameVersions: ['1.21.2'], loaders: ['fabric'], files: [{ url: '', filename: 'sodium-0.6.3.jar', size: 1048576, hashSha1: '', primary: true }], dependencies: [{ projectId: 'b', type: 'required' }] },
    { id: 'v2', name: 'Sodium 0.6.2', versionNumber: '0.6.2+mc1.21.1', date: '', gameVersions: ['1.21.1'], loaders: ['fabric'], files: [{ url: '', filename: 'sodium-0.6.2.jar', size: 1048576, hashSha1: '', primary: true }], dependencies: [] },
  ],
  contentInstall: async () => ({ ok: true, files: [{ filename: 'sodium-0.6.3.jar', dep: false, path: 'mods/' }] }),
  onContentProgress: () => () => {},
  accountsList: async () => ({ list: mockStoreList, activeId: 'authlib-s1' }),
  accountsSwitch: async (uid) => ({ name: uid, type: 'offline' }),
  accountsRemove: async () => {},
  accountsAddOffline: async (n) => { mockStoreList.push({ uid: 'offline-' + n, type: 'offline', name: n, uuid: 'x-' + n, payload: {} }); return { name: n, type: 'offline' }; },
  clipboardRead: async () => (typeof window !== 'undefined' && window.__mockClip) || '',
  serversList: async () => ([
    { id: 'swust-41005', name: '长期生存服', host: 'mc.swustmc.cn', port: 41005, note: '第一周目 · Velocity 1.7.2-26.3', builtin: true, instanceId: '1.21.2' },
    { id: 'swust-41004', name: '第10周小游戏minigames', host: 'mc.swustmc.cn', port: 41004, note: '周目：第一周目', builtin: true },
  ]),
  serversPing: async (host, port) => (port === 41004 ? { online: false } : { online: true, players: { online: 2, max: 500 }, version: 'Velocity 1.7.2-26.3', latency: 25, favicon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAGJJREFUeF7t0QEBAAAAgJD+r+4ICgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPwGfgAAAdWlPqEAAAAASUVORK5CYII=' }),
  serversSave: async (e) => e,
  serversRemove: async () => true,
  historyList: async () => { const now = Date.now(); return [
    { id: '1.21.2', dir: 'D:/mock/.minecraft', start: now - 86400000 * 1 - 3600000, end: now - 86400000 * 1 },
    { id: 'SWUSTMC-特供包', dir: 'D:/mock/.minecraft', start: now - 86400000 * 3 - 7200000, end: now - 86400000 * 3 },
  ]; },
  instanceLog: async () => ({ file: 'D:/mock/logs/test.log', exists: true, lines: ['[12:00:01] [main/INFO]: Environment: mock', '[12:00:02] [Render thread/INFO]: Backend library: LWJGL'] }),
  instanceLogClear: async () => true,
  closeChoice: async () => ({ ok: true }),
  instanceAssets: async (dir, id, kind) => ({
    folder: 'D:/mock/.minecraft/' + kind,
    items: kind === 'screenshots'
      ? [
          { name: '2026-11-07_20.15.33.png', path: 'D:/mock/a.png', size: 1348576, mtime: Date.now() - 3600000, dir: false, thumb: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
          { name: '2026-11-06_18.02.11.png', path: 'D:/mock/b.png', size: 964224, mtime: Date.now() - 90000000, dir: false, thumb: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
        ]
      : [
          { name: 'Sodium-0.6.3.zip', path: 'D:/mock/sodium.zip', size: 2097152, mtime: Date.now() - 7200000, dir: false },
          { name: 'BSL-Shaders.zip', path: 'D:/mock/bsl.zip', size: 5242880, mtime: Date.now() - 172800000, dir: false },
        ],
  }),
  instanceAssetTrash: async () => true,
  authStatus: async () => ({ mode: 'offline', name: 'Steve', uuid: 'mock', skinUrl: '' }),
  authLogin: async () => { emit('auth:stage', { stage: 'code', userCode: 'ABCD123EF', url: 'https://www.microsoft.com/link', copied: true, message: '请在打开的页面输入代码' }); await new Promise((r) => setTimeout(r, 15000)); return { name: 'Steve', uuid: 'mock' }; },
  authCancel: () => {},
  authLogout: () => {},
  onAuthStage: () => () => {},
  onAuthDone: () => () => {},
  onAuthFailed: () => () => {},
  getAvatar: async () => ({ file: null, dataUrl: 'data:image/png;base64,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', cached: false }),
  skinImport: async () => null,
  skinClear: async () => true,
  skinLocal: async () => null,
  pickDir: async () => null,
  pickJava: async () => null,

  modsList: async () => [
    { file: 'C:/x/sodium.jar', name: 'sodium.jar', fileName: 'sodium.jar', enabled: true, size: 943718, mtime: Date.now(), modName: 'Sodium', version: 'mc1.21.2-0.6.3', authors: 'jellysquid3', icon: null, description: '现代渲染引擎' },
    { file: 'C:/x/fabric-api.jar', name: 'fabric-api.jar', fileName: 'fabric-api.jar', enabled: true, size: 2097152, mtime: Date.now(), modName: 'Fabric API', version: '0.116.0+1.21.2', authors: 'modmuss50', icon: null, description: '核心前置库' },
    { file: 'C:/x/litematica.jar', name: 'litematica.jar.disabled', fileName: 'litematica.jar.disabled', enabled: false, size: 1572864, mtime: Date.now(), modName: 'Litematica', version: '0.29.1', authors: 'masa', icon: null, description: '原理图' },
    { file: 'C:/x/iris.jar', name: 'iris.jar', fileName: 'iris.jar', enabled: true, size: 734003, mtime: Date.now(), modName: 'Iris Shaders', version: '1.8.0+1.21.2', authors: 'coderbot', icon: null, description: '光影加载器' },
  ],
  modsToggle: async () => ({}),
  modsDelete: async () => ({}),
  modsCheckUpdate: async () => ({ known: true, current: { versionNumber: '0.6.3' }, latest: { versionNumber: '0.6.4', url: '', filename: 'sodium-0.6.4.jar' } }),
  modsApplyUpdate: async () => ({}),
  instanceGetSettings: async () => ({ displayName: '', javaPath: '', memory: 0, jvmArgs: '', isolate: 'auto' }),
  instanceSaveSettings: async () => ({}),
  instanceRename: async () => ({}),
  authlibMeta: async (url) => ({ root: url, serverName: 'LittleSkin', skinDomains: [] }),
  authlibLogin: async () => ({ serverName: 'LittleSkin', profiles: [{ id: 'a', name: 'nai_ning' }], selected: { id: 'a', name: 'nai_ning' } }),
  authlibSelectProfile: async () => ({ selected: { id: 'a', name: 'nai_ning' } }),
  authlibLogout: () => {},

  openPath: async () => true,
  openUrl: async () => true,
  wallpaperPick: async () => null,
  wallpaperClear: async () => settings,
  wallpaperPalette: async () => ({ sampled: false, hue: 214, sat: 0.68, dark: { base: '#1668dc', base2: '#4b8df0', soft: 'rgba(22,104,220,0.18)' }, light: { base: '#0f56bb', base2: '#3a7de0', soft: 'rgba(22,104,220,0.13)' } }),
  applyGpuAll: async () => ({ supported: true, mode: 'high', applied: [], failed: [] }),
  checkUpdate: async () => ({ available: false, version: '', current: '1.0.0', notes: '', asset: null }),
  installUpdate: async () => ({ ok: true }),
  onUpdateAvailable: () => () => {},
  onUpdateProgress: () => () => {},
  onUpdateChangelog: () => () => {},
  onNewRelease: () => () => {},
  logRecent: async () => [
    { t: Date.now() - 9000, level: 'info', text: '星启 SWUSTMCL 1.0.0 启动（GPU 兼容标记：关）' },
    { t: Date.now() - 8000, level: 'info', text: '发现 3 个游戏目录（PCL 便携版已通过桌面快捷方式定位）' },
    { t: Date.now() - 7000, level: 'game', text: '[12:00:01] [main/INFO]: Environment: Environment[sessionClient=net.minecraft.client.main.Main]' },
    { t: Date.now() - 6000, level: 'game-err', text: '[12:00:02] [Render thread/ERROR]: Failed to load sound event block.note_block' },
    { t: Date.now() - 5000, level: 'warn', text: '内存分配 4096MB，建议不超过物理内存 60%' },
  ],
  logClear: () => {},
  onLog: () => () => {},
  onLogCleared: () => () => {},
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
const listeners = {};
function emit(channel, payload) { (listeners[channel] || []).forEach((fn) => fn(payload)); }
const mockStoreList = [
  { uid: 'offline-steve', type: 'offline', name: 'Steve', uuid: 'x1', payload: {} },
  { uid: 'authlib-s1', type: 'authlib', name: 'nai_ning', uuid: 'u2', payload: { root: 'https://www.swustmc.cn/api/yggdrasil', profiles: [{ id: 'u2', name: 'nai_ning' }, { id: 'u3', name: 'xiaoming' }], selected: { id: 'u2', name: 'nai_ning' } } },
];

// 事件订阅 mock：通道名写死在函数体里（函数源码会被序列化到页面执行）
const onChan = (ch) => new Function('cb', `(listeners[${JSON.stringify(ch)}] = listeners[${JSON.stringify(ch)}] || []).push(cb); return () => {};`);
mock.onJavaProgress = onChan('java:progress');
mock.onInstall = onChan('install:progress');
mock.onLoader = onChan('loader:progress');
mock.onPack = onChan('modpack:progress');
mock.onExportProgress = onChan('pack:exportProgress');
mock.onContentProgress = onChan('content:progress');
mock.onSavesProgress = onChan('saves:progress');
mock.onVersionSize = onChan('versions:size');
mock.onSettingsChanged = onChan('settings:changed');
mock.onGameStarted = onChan('game:started');
mock.onGameExit = onChan('game:exit');
mock.onGameError = onChan('game:error');
mock.onAuthStage = onChan('auth:stage');
mock.onAuthDone = onChan('auth:done');
mock.onAuthFailed = onChan('auth:failed');
mock.onNewRelease = onChan('manifest:latest');
mock.onUpdateAvailable = onChan('update:available');
mock.onUpdateProgress = onChan('update:progress');
mock.onUpdateChangelog = onChan('update:changelog');
mock.onLog = onChan('game:log');
mock.onLogCleared = onChan('game:log:cleared');
mock.onClosePrompt = onChan('app:close-prompt');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let p = url.pathname === '/' ? '/index.html' : url.pathname;

  if (p === '/mock.js') {
    res.writeHead(200, { 'Content-Type': MIME['.js'] });
    res.end(buildMockScript());
    return;
  }
  if (p === '/mock-raw.js') {
    res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' });
    res.end(buildMockScript());
    return;
  }

  const file = path.join(renderer, path.normalize(p).replace(/^([.][.][/\\])+/, ''));
  if (!file.startsWith(renderer)) {
    res.writeHead(403); res.end(); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404); res.end('not found'); return;
    }
    let out = data;
    if (p === '/index.html') {
      // 注入 mock（在 store.js 之前）
      out = Buffer.from(data.toString('utf8').replace(
        '<script src="js/store.js">',
        '<script src="/mock-raw.js"></script><script src="js/store.js">'
      ));
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(out);
  });
});

/** 把 mock 序列化成可执行的 JS：先注入数据，再注入函数源码（闭包在页面里重建） */
function buildMockScript() {
  const dataVars = { settings, installed, saves, manifestVersions, javaList, modrinthHits, taskMapMock, mockStoreList };
  const lines = [];
  for (const [k, v] of Object.entries(dataVars)) {
    lines.push(`const ${k} = ${JSON.stringify(v)};`);
  }
  lines.push('let gameRunning = false;');
  lines.push('const listeners = {};');
  lines.push('function emit(channel, payload) { (listeners[channel] || []).forEach((fn) => fn(payload)); }');
  lines.push('function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }');
  lines.push('window.smcl = {');
  for (const [k, v] of Object.entries(mock)) {
    lines.push(typeof v === 'function' ? `  ${k}: ${v.toString()},` : `  ${k}: ${JSON.stringify(v)},`);
  }
  lines.push('};');
  return lines.join('\n');
}

server.listen(18235, '127.0.0.1', () => {
  console.log('mock preview: http://127.0.0.1:18235');
});
