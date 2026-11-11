'use strict';
/**
 * 渲染层唯一入口：contextBridge 白名单。
 * 全部通道的参数都会在主进程再校验一次。
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel, cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('smcl', {
  version: '1.2.0',

  // 应用 / 窗口
  state: () => ipcRenderer.invoke('app:state'),
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
  },

  // 设置
  save: (patch) => ipcRenderer.invoke('settings:save', patch),
  onSettingsChanged: (cb) => on('settings:changed', cb),

  // 游戏目录 / Java
  dirs: () => ipcRenderer.invoke('dirs:list'),
  addDir: () => ipcRenderer.invoke('dirs:add'),
  removeDir: (path) => ipcRenderer.invoke('dirs:remove', { path }),
  detectJava: () => ipcRenderer.invoke('java:detect'),

  // 版本
  manifest: (opts) => ipcRenderer.invoke('versions:manifest', opts || {}),
  installed: () => ipcRenderer.invoke('versions:installed'),
  sizes: () => ipcRenderer.invoke('versions:sizes'),
  onVersionSize: (cb) => on('versions:size', cb),
  deleteVersion: (id, dir) => ipcRenderer.invoke('version:delete', { id, dir }),
  versionCommand: (id, dir) => ipcRenderer.invoke('version:command', { id, dir }),

  // 安装 / 修复
  install: (id, url) => ipcRenderer.invoke('install:start', { id, url }),
  onInstall: (cb) => on('install:progress', cb),
  onJavaProgress: (cb) => on('java:progress', cb),
  repair: (id, dir) => ipcRenderer.invoke('game:repair', { id, dir }),

  // 启动
  launch: (id, dir, opts) => ipcRenderer.invoke('game:launch', { id, dir, ...(opts || {}) }),
  kill: (pid) => ipcRenderer.invoke('game:kill', { pid }),
  onClosePrompt: (cb) => on('app:close-prompt', cb),
  closeChoice: (payload) => ipcRenderer.invoke('app:close-choice', payload),
  copyCommand: (id, dir) => ipcRenderer.invoke('game:copyCommand', { id, dir }),
  openLogFile: () => ipcRenderer.invoke('game:openLog'),
  onGameStarted: (cb) => on('game:started', cb),
  onGameExit: (cb) => on('game:exit', cb),
  onGameError: (cb) => on('game:error', cb),

  // 存档
  saves: () => ipcRenderer.invoke('saves:list'),
  onSavesProgress: (cb) => on('saves:progress', cb),
  revealSave: (path) => ipcRenderer.invoke('saves:reveal', { path }),
  trashSave: (path) => ipcRenderer.invoke('saves:trash', { path }),

  // 加载器
  listLoaders: (loader, mc) => ipcRenderer.invoke('loader:list', { loader, mc }),
  installLoader: (loader, mc, loaderVersion, instanceId) =>
    ipcRenderer.invoke('loader:install', { loader, mc, loaderVersion, instanceId }),
  onLoader: (cb) => on('loader:progress', cb),

  // 整合包
  pickPack: () => ipcRenderer.invoke('modpack:pick'),
  inspectPack: (file) => ipcRenderer.invoke('modpack:inspect', { file }),
  installPack: (file) => ipcRenderer.invoke('modpack:install', { file }),
  onPack: (cb) => on('modpack:progress', cb),
  exportPlan: (id, dir) => ipcRenderer.invoke('pack:exportPlan', { id, dir }),
  exportPick: (defaultName) => ipcRenderer.invoke('pack:exportPick', { defaultName }),
  exportPack: (id, dest, dir) => ipcRenderer.invoke('pack:export', { id, dir, dest }),
  onExportProgress: (cb) => on('pack:exportProgress', cb),

  // 资源
  contentSearch: (payload) => ipcRenderer.invoke('content:search', payload),
  contentChineseAlias: (query) => ipcRenderer.invoke('content:chineseAlias', { query }),
  translationStats: () => ipcRenderer.invoke('translation:stats'),
  contentVersions: (payload) => ipcRenderer.invoke('content:versions', payload),
  contentInstall: (payload) => ipcRenderer.invoke('content:install', payload),
  onContentProgress: (cb) => on('content:progress', cb),

  // 账号
  authStatus: () => ipcRenderer.invoke('auth:status'),
  authLogin: () => ipcRenderer.invoke('auth:login'),
  authCancel: () => ipcRenderer.send('auth:cancel'),
  authLogout: () => ipcRenderer.send('auth:logout'),
  onAuthStage: (cb) => on('auth:stage', cb),
  onAuthDone: (cb) => on('auth:done', cb),
  onAuthFailed: (cb) => on('auth:failed', cb),
  accountsList: () => ipcRenderer.invoke('accounts:list'),
  accountsSwitch: (uid) => ipcRenderer.invoke('accounts:switch', { uid }),
  accountsAddOffline: (name) => ipcRenderer.invoke('accounts:addOffline', { name }),
  accountsRemove: (uid) => ipcRenderer.invoke('accounts:remove', { uid }),
  getAvatar: (uuid, name, force) => ipcRenderer.invoke('avatar:get', { uuid, name, force }), // => {file, dataUrl, cached}
  skinImport: () => ipcRenderer.invoke('skin:import'),
  skinClear: () => ipcRenderer.invoke('skin:clear'),
  skinLocal: (name) => ipcRenderer.invoke('skin:local', { name }),

  // 对话框 / 打开
  pickDir: () => ipcRenderer.invoke('dialog:pickDir'),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  pickDirNew: () => ipcRenderer.invoke('dialog:pickDirNew'),
  pickJava: () => ipcRenderer.invoke('dialog:pickJava'),
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),
  clipboardWrite: (text) => ipcRenderer.invoke('clipboard:write', { text }),
  openPath: (target) => ipcRenderer.invoke('open:path', { target }),
  openUrl: (url) => ipcRenderer.invoke('open:url', { url }),

  // 服务器 / 历史 / 实例日志
  serversList: () => ipcRenderer.invoke('servers:list'),
  serversPing: (host, port) => ipcRenderer.invoke('servers:ping', { host, port }),
  serversSave: (entry) => ipcRenderer.invoke('servers:save', entry),
  serversRemove: (id) => ipcRenderer.invoke('servers:remove', id),

  // 启动器域
  domainsList: () => ipcRenderer.invoke('domains:list'),
  domainsState: () => ipcRenderer.invoke('domains:state'),
  domainsSetActive: (id) => ipcRenderer.invoke('domains:setActive', { id }),
  domainsAdd: (input) => ipcRenderer.invoke('domains:add', { input }),
  domainsRemove: (id) => ipcRenderer.invoke('domains:remove', { id }),
  domainsRefresh: (id) => ipcRenderer.invoke('domains:refresh', { id }),
  domainDownloadResource: (domainId, resourceId) =>
    ipcRenderer.invoke('domains:downloadResource', { domainId, resourceId }),
  domainInstallResource: (domainId, resourceId, instanceDir) =>
    ipcRenderer.invoke('domains:installResource', { domainId, resourceId, instanceDir }),
  onDomainAdded: (cb) => on('domains:added', cb),
  onDomainError: (cb) => on('domains:error', cb),
  onDomainResourceProgress: (cb) => on('domains:resourceProgress', cb),

  // 域整合包发布 / 安装
  domainPackScan: (dir, id) => ipcRenderer.invoke('domainpacks:scan', { dir, id }),
  domainPackPublish: (payload) => ipcRenderer.invoke('domainpacks:publish', payload),
  domainPackInstall: (payload) => ipcRenderer.invoke('domainpacks:install', payload),
  domainPackTokenStatus: (domainId) => ipcRenderer.invoke('domainpacks:tokenStatus', { domainId }),
  domainPackSetToken: (domainId, token) => ipcRenderer.invoke('domainpacks:setToken', { domainId, token }),
  domainPackInstalled: () => ipcRenderer.invoke('domainpacks:installed'),
  onDomainPackProgress: (cb) => on('domainpacks:progress', cb),

  historyList: () => ipcRenderer.invoke('history:list'),
  instanceLog: (id, lines) => ipcRenderer.invoke('log:instance', { id, lines }),
  instanceLogClear: (id) => ipcRenderer.invoke('log:instance:clear', { id }),
  instanceAssets: (dir, id, kind) => ipcRenderer.invoke('instance:assets', { dir, id, kind }),
  instanceAssetTrash: (path) => ipcRenderer.invoke('instance:asset:trash', { path }),

  // 壁纸
  wallpaperPick: (slot) => ipcRenderer.invoke('wallpaper:pick', slot),
  wallpaperRemove: (name) => ipcRenderer.invoke('wallpaper:remove', name),
  wallpaperClear: (slot) => ipcRenderer.invoke('wallpaper:clear', slot),
  wallpaperPalette: (image) => ipcRenderer.invoke('wallpaper:palette', { image }),

  // 显卡
  applyGpuAll: (mode) => ipcRenderer.invoke('gpu:applyAll', { mode }),
  gpuStatus: () => ipcRenderer.invoke('gpu:status'),

  // 内存
  freeMemory: () => ipcRenderer.invoke('memory:free'),
  memoryUsage: () => ipcRenderer.invoke('memory:usage'),
  memoryAuto: () => ipcRenderer.invoke('memory:auto'),

  // 实例级管理
  instanceGetSettings: (dir, id) => ipcRenderer.invoke('instance:settings:get', { dir, id }),
  instanceSaveSettings: (dir, id, patch) => ipcRenderer.invoke('instance:settings:save', { dir, id, patch }),
  instanceRename: (dir, oldId, newId) => ipcRenderer.invoke('instance:rename', { dir, oldId, newId }),
  modsList: (dir, id) => ipcRenderer.invoke('mods:list', { dir, id }),
  modsToggle: (file, enabled) => ipcRenderer.invoke('mods:toggle', { file, enabled }),
  modsDelete: (file) => ipcRenderer.invoke('mods:delete', { file }),
  modsCheckUpdate: (file, gameVersion) => ipcRenderer.invoke('mods:checkUpdate', { file, gameVersion }),
  modsApplyUpdate: (file, url, filename) => ipcRenderer.invoke('mods:applyUpdate', { file, url, filename }),

  // 第三方皮肤站（authlib-injector）
  authlibMeta: (url) => ipcRenderer.invoke('authlib:meta', { url }),
  authlibLogin: (url, username, password) => ipcRenderer.invoke('authlib:login', { url, username, password }),
  authlibSelectProfile: (profileId) => ipcRenderer.invoke('authlib:selectProfile', { profileId }),
  accountsSelectProfile: (uid, profileId) => ipcRenderer.invoke('accounts:selectProfile', { uid, profileId }),
  authlibLogout: () => ipcRenderer.send('authlib:logout'),

  // 启动器更新
  appInfo: () => ipcRenderer.invoke('app:info'),
  checkUpdate: (opts) => ipcRenderer.invoke('update:check', opts || {}),
  installUpdate: (asset) => ipcRenderer.invoke('update:install', { asset }),
  onUpdateAvailable: (cb) => on('update:available', cb),
  onUpdateProgress: (cb) => on('update:progress', cb),
  onUpdateChangelog: (cb) => on('update:changelog', cb),
  onNewRelease: (cb) => on('manifest:latest', cb),

  // 日志
  logRecent: () => ipcRenderer.invoke('log:recent'),
  logClear: () => ipcRenderer.send('log:clear'),
  onLog: (cb) => on('game:log', cb),
  onLogCleared: (cb) => on('game:log:cleared', cb),
});
