'use strict';
/**
 * 星启 SWUSTMCL — 主进程入口。
 *
 * 安全模型：
 *   - contextIsolation: true，nodeIntegration: false，sandbox: true；
 *   - 渲染层只能通过 preload 暴露的白名单 API 调用主进程；
 *   - 所有 IPC 参数在 core/safe.js 与各 handler 里二次校验；
 *   - smcl-wall:// 协议只读 userData/wallpapers/ 白名单文件。
 */
const { app, BrowserWindow, ipcMain, dialog, shell, Notification, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ------------------------------------------------------------ 便携模式（先于一切）
// 免安装发行版把全部数据（配置/缓存/密钥/壁纸）放在 exe 旁的 userdata/，
// 不碰 %APPDATA% —— 部分机器对 AppData 存在系统级写保护（Chromium 网络沙箱
// 会报 0x5 并导致启动失败），且便携应用本就该"删目录即卸载"。
if (app.isPackaged) {
  app.setPath('userData', path.join(path.dirname(app.getPath('exe')), 'userdata'));
}

// ------------------------------------------------------------ GPU 兜底（先于 ready）
const FALLBACK_ARGS = ['--no-sandbox', '--disable-gpu-sandbox', '--disable-gpu-compositing'];
const MARKER_ARG = '--swustmcl-gpu-fallback';
const isFallbackLaunch = process.argv.includes(MARKER_ARG);

const fsSelf = require('fs');
// userData 可写性自检：缓存目录 ACL 损坏（常见于曾被安全软件拦截后残留）会让
// Chromium 网络沙箱全部报 0x5 拒绝访问，表现为启动即退。改名让框架原样重建。
try {
  const ud = app.getPath('userData');
  fsSelf.mkdirSync(ud, { recursive: true });
  const probe = path.join(ud, '.write-test');
  fsSelf.writeFileSync(probe, 'ok');
  fsSelf.unlinkSync(probe);
} catch (e) {
  try {
    const ud = app.getPath('userData');
    // 只清理导致网络沙箱 0x5 的缓存子目录，绝不动配置/密钥/皮肤
    for (const sub of ['Cache', 'Cache Data', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Network', 'blob_storage', 'Shared Dictionary', 'Session Storage']) {
      fsSelf.rmSync(path.join(ud, sub), { recursive: true, force: true });
    }
    console.warn('[boot] userData 写入失败，已清理缓存子目录:', e.message);
  } catch {}
}

const settingsLib = require('./core/settings');
settingsLib.init();
const bootSettings = settingsLib.all();
require('./core/net').setDoh(bootSettings.doh);

function relaunchCompat() {
  const args = process.argv.slice(1).concat(FALLBACK_ARGS, MARKER_ARG);
  app.relaunch({ args });
  app.exit(0);
}

// 标记存在：本次直接以兼容模式启动（且禁用硬件加速），不再二次重启
if (bootSettings.gpuFallback) {
  console.log('[gpu] 检测到 GPU 兼容标记，本次以兼容模式启动');
  app.disableHardwareAcceleration();
}

// 主进程未捕获异常落盘（便携：写在 exe 旁，不依赖 userData 可写性）
process.on('uncaughtException', (e) => {
  try {
    const dir = path.dirname(app.getPath('exe'));
    fs.appendFileSync(
      path.join(dir, 'crash.log'),
      `\n[${new Date().toISOString()}] ${e.stack || e.message}\n`
    );
  } catch {}
});

const core = {
  log: require('./core/log'),
  net: require('./core/net'),
  mirror: require('./core/mirror'),
  safe: require('./core/safe'),
  dirs: require('./core/dirs'),
  nbt: require('./core/nbt'),
  saves: require('./core/saves'),
  versions: require('./core/versions'),
  rules: require('./core/rules'),
  install: require('./core/install'),
  repair: require('./core/repair'),
  loaders: require('./core/loaders'),
  launch: require('./core/launch'),
  java: require('./core/java'),
  auth: require('./core/auth'),
  account: require('./core/account'),
  modpack: require('./core/modpack'),
  content: require('./core/content'),
  updater: require('./core/updater'),
  wallpaper: require('./core/wallpaper'),
  gpu: require('./core/gpu'),
  compat: require('./core/compat'),
  memory: require('./core/memory'),
  javainstall: require('./core/javainstall'),
  accountstore: require('./core/accountstore'),
  instances: require('./core/instances'),
  authlib: require('./core/authlib'),
  servers: require('./core/servers'),
  domains: require('./core/domains'),
  domainpacks: require('./core/domainpacks'),
  history: require('./core/history'),
  instancelog: require('./core/instancelog'),
  instanceassets: require('./core/instanceassets'),
};

const log = core.log;

/** 当前站点型域的 authlib 根地址；个人域返回空串。 */
function normalizeDomainRoot(value) {
  return String(value || '').replace(/\/+$/, '');
}
function activeSiteDomain() {
  try {
    const domain = core.domains.active();
    return domain && !domain.personal ? domain : null;
  } catch {
    return null;
  }
}
function activeDomainRoot() {
  const domain = activeSiteDomain();
  if (!domain) return '';
  const manifest = domain.manifest || {};
  return normalizeDomainRoot((manifest.auth && manifest.auth.yggdrasilUrl) || manifest.yggdrasilUrl || '');
}
/** 域内账号必须且只能来自该域对应的皮肤站。 */
function assertAccountAllowedInDomain(entry) {
  const domain = activeSiteDomain();
  if (!domain) return;
  const root = activeDomainRoot();
  if (!root || !entry || entry.type !== 'authlib' || normalizeDomainRoot(entry.payload && entry.payload.root) !== root) {
    throw new Error('当前处于「' + (domain.name || '站点域') + '」，只能使用该域对应皮肤站的账号');
  }
}
/** 离开个人域前记住当前账户，回来时恢复。 */
function rememberPersonalAccount() {
  const current = core.domains.active();
  if (!current || !current.personal) return;
  const currentId = core.accountstore.activeId();
  if (currentId) settingsLib.save({ personalAccountId: currentId });
}
const wall = core.wallpaper;
wall.registerScheme(); // 必须在 app ready 前

let win = null; // 主窗口引用（日志转发与 compat 检查都可能早于窗口创建触发）

// 游戏与主进程日志实时推给渲染层（底部日志抽屉）
// 游戏行同时写入「当前实例」自己的日志文件，实例之间互不串行
log.onLine((line) => send('game:log', line));
log.onCleared(() => send('game:log:cleared'));

// ------------------------------------------------------------ 第三方软件兼容
// 搜狗等输入法的云组件会向新进程注入 DLL，令 Electron 在窗口创建前就崩溃。
// 必须赶在 Chromium 初始化完成前同步处理（此处阻塞最多 ~200ms，值得）。
if (settingsLib.all().autoFixInjectors !== false) {
  const r = core.compat.stopKnownInjectorsSync((msg) => log.warn(msg));
  if (r.stopped.length) console.log('[compat] 已结束第三方注入组件:', r.stopped.join(', '));
}


const gameProcs = new Map(); // 多开：sessionId -> { id, dir, start, proc }
let busy = { install: null, modpack: null, loader: null, content: null, update: null };
let latestReleaseCache = null;

const isDev = !app.isPackaged || process.argv.includes('--dev');

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ------------------------------------------------------------ 单实例锁 / 域邀请协议
function protocolUrlFromArgs(argv) {
  return (argv || []).find((arg) => /^swustmcl:\/\//i.test(String(arg || ''))) || '';
}

async function handleProtocolUrl(raw) {
  try {
    const url = new URL(String(raw));
    if (url.hostname !== 'add-domain' && url.hostname !== 'domain') return;
    const target = url.searchParams.get('url');
    if (!target) throw new Error('邀请缺少域地址');
    rememberPersonalAccount();
    const item = await core.domains.add(target);
    send('domains:added', item);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    log.info('已添加域：' + item.name);
  } catch (e) {
    log.warn('域邀请处理失败：' + (e && e.message));
    send('domains:error', { message: (e && e.message) || '域邀请处理失败' });
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    const invite = protocolUrlFromArgs(argv);
    if (invite) handleProtocolUrl(invite);
  });
}

// ------------------------------------------------------------ 窗口
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 820,
    minHeight: 680,
    show: false,
    frame: false,
    backgroundColor: '#0b0e14',
    icon: (() => { const ico = path.join(path.dirname(process.execPath), 'icon.ico'); return fs.existsSync(ico) ? ico : path.join(__dirname, '..', 'renderer', 'assets', 'logo.png'); })(),
    title: '星启 SWUSTMCL',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('[renderer]', message);
  });

  // 阻断一切导航：拖入链接 / window.location 跳转都会重新注入 preload
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://') && !url.startsWith(`${wall.SCHEME}://`)) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (core.safe.isHttpUrl(url, core.safe.PAGE_HOSTS)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 关闭启动器：按设置询问 / 最小化 / 直接退出（游戏窗口不受影响）
  // 询问时由渲染层弹出主题化确认框（原生 MessageBox 与界面风格不符）
  mwState.allowClose = false;
  win.on('close', (e) => {
    if (mwState.allowClose) return;
    const action = settingsLib.all().closeAction || 'ask';
    if (action === 'minimize') {
      e.preventDefault();
      win.minimize();
      return;
    }
    if (action === 'close') return;
    e.preventDefault();
    // 再次点关闭（30 秒内）视为确认退出，避免弹窗异常时窗口关不掉
    if (Date.now() - (mwState.promptAt || 0) < 30000) {
      mwState.allowClose = true;
      win.close();
      return;
    }
    mwState.promptAt = Date.now();
    try { send('app:close-prompt'); } catch {}
  });

  win.once('ready-to-show', () => {
    win.show();
    if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  });
  win.on('closed', () => {
    win = null;
  });
  // 渲染进程卡死检测：写 crash.log 便于远程定位（不自动杀进程，给用户恢复机会）
  win.webContents.on('unresponsive', () => {
    const msg = `渲染进程无响应 ${new Date().toISOString()}（可能是某个同步操作耗时过长）`;
    log.error(msg);
    try { fs.appendFileSync(path.join(__dirname, '..', 'crash.log'), msg + '\n'); } catch {}
  });
  win.webContents.on('responsive', () => {
    log.info('渲染进程已恢复响应');
  });

  // 开发辅助：SMCL_SHOT=1 [SMCL_SHOT_VIEW=<view>|all] 自动截图后退出（自测 UI 用）。
  // 仅开发模式可用：它会执行 SMCL_SHOT_JS 里的任意脚本，不能留给正式版本。
  const shotMode = !app.isPackaged && (process.env.SMCL_SHOT === '1' || process.argv.includes('--shot'));
  if (shotMode) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const fsx = require('fs');
          const outDir = path.join(__dirname, '..', 'build', 'shots');
          fsx.mkdirSync(outDir, { recursive: true });
          const views = ['home', 'versions', 'download', 'packs', 'content', 'saves', 'settings'];
          const only = process.env.SMCL_SHOT_VIEW;
          if (process.env.SMCL_SHOT_JS) {
            await win.webContents.executeJavaScript(process.env.SMCL_SHOT_JS);
            await new Promise((r) => setTimeout(r, 2000));
          }
          const list = only && only !== 'all' ? [only] : views;
          for (const v of list) {
            await win.webContents.executeJavaScript(
              `document.querySelector('[data-view="${v}"]')?.click(); true`
            );
            await new Promise((r) => setTimeout(r, v === 'saves' ? 4000 : 2200));
            const img = await win.webContents.capturePage();
            fsx.writeFileSync(path.join(outDir, `${v}.png`), img.toPNG());
            console.log('[shot] saved', v);
          }
        } catch (e) {
          console.error('[shot] failed', e);
        }
        app.quit();
      }, 3500);
    });
  }
}

app.on('child-process-gone', (_e, details) => {
  if (!details || details.type !== 'GPU' || isFallbackLaunch) return;
  if (details.reason === 'clean-exit' || details.reason === 'killed') return;
  if (settingsLib.all().gpuFallback) return;
  console.log('[gpu] GPU 进程异常退出，写入兼容标记并带参数重启：', details.reason);
  log.warn(`GPU 进程异常退出（${details.reason}），已写入兼容标记，即将以兼容模式重启`);
  settingsLib.save({ gpuFallback: true });
  relaunchCompat();
});

/** 用户导入的壁纸若与内置默认图完全相同，清空自定义槽位，让昼夜自动切换生效 */
function migrateBuiltinWallpaperDupes() {
  try {
    const assetsDir = path.join(__dirname, '..', 'renderer', 'assets');
    const builtin = ['default-wallpaper.png', 'default-wallpaper-day.png', 'default-wallpaper-light.png'];
    const hashes = new Set();
    for (const name of builtin) {
      try {
        hashes.add(crypto.createHash('sha256').update(fs.readFileSync(path.join(assetsDir, name))).digest('hex'));
      } catch {}
    }
    if (!hashes.size) return;
    const sameAsBuiltin = (name) => {
      if (!name) return false;
      try {
        const file = path.join(wall.root(), name);
        const size = fs.statSync(file).size;
        if (size > 40 * 1024 * 1024) return false;
        return hashes.has(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
      } catch {
        return false;
      }
    };
    const wp = settingsLib.all().wallpaper || {};
    const patch = {};
    if (sameAsBuiltin(wp.image)) patch.image = '';
    if (sameAsBuiltin(wp.imageLight)) patch.imageLight = '';
    if (Object.keys(patch).length) {
      settingsLib.save({ wallpaper: { ...wp, ...patch } });
      log.info('壁纸迁移：自定义图与内置默认图相同，已恢复按时间段自动切换');
    }
  } catch {}
}

app.setAppUserModelId('cn.swust.swustmcl');

// swustmcl:// 域邀请协议：网页拖拽/点击可把域直接加进启动器
try {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('swustmcl', process.execPath, [path.resolve(process.argv[1])]);
    }
  } else if (app.isPackaged) {
    app.setAsDefaultProtocolClient('swustmcl');
  }
} catch (e) {
  log.warn('域邀请协议注册失败：' + (e && e.message));
}
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleProtocolUrl(url);
});

app.whenReady().then(async () => {
  wall.registerHandler();
  // 便携目录：旧版本默认把游戏装到 %APPDATA%\.minecraft，这里一次性改到启动器同目录
  try {
    const APPDATA = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
    const legacy = path.join(APPDATA, '.minecraft');
    const portable = path.join(path.dirname(app.getPath('exe')), '.minecraft');
    const migrateFlag = path.join(app.getPath('userData'), 'portable-dir.flag');
    const cur = settingsLib.all().mcDir || '';
    const isLegacy = cur && path.resolve(cur).toLowerCase() === path.resolve(legacy).toLowerCase();
    if (app.isPackaged && isLegacy && !fs.existsSync(migrateFlag) && path.resolve(portable) !== path.resolve(legacy)) {
      settingsLib.save({ mcDir: portable });
      log.info('游戏目录迁移：' + legacy + ' → ' + portable);
    }
    if (app.isPackaged) fs.writeFileSync(migrateFlag, new Date().toISOString(), 'utf8');
    const finalDir = settingsLib.all().mcDir;
    if (finalDir) {
      fs.mkdirSync(path.join(finalDir, 'versions'), { recursive: true });
      fs.mkdirSync(finalDir, { recursive: true });
    }
  } catch (e) {
    log.warn('游戏目录初始化失败：' + e.message);
  }
  migrateBuiltinWallpaperDupes();
  // 壁纸模式迁移：补默认值；旧 image 视作夜间壁纸
  try {
    const wp0 = settingsLib.all().wallpaper || {};
    // 一次性自愈：早期版本保存壁纸参数时会把 enabled 误写成 false（无自定义图时）
    try {
      const healFlag = path.join(app.getPath('userData'), 'wallpaper-heal.flag');
      const wpH = settingsLib.all().wallpaper || {};
      const noImgs = !wpH.image && !wpH.imageLight && !wpH.dayImage && !wpH.nightImage && !(wpH.images || []).length;
      if (wpH.enabled === false && noImgs && !fs.existsSync(healFlag)) {
        settingsLib.save({ wallpaper: { ...wpH, enabled: true } });
        fs.writeFileSync(healFlag, new Date().toISOString(), 'utf8');
        log.info('壁纸设置自愈：恢复内置默认壁纸显示');
      }
    } catch {}
    if (wp0.mode !== 'daynight' && wp0.mode !== 'slideshow') {
      const next = { ...wp0, mode: 'daynight', intervalMin: wp0.intervalMin || 10, images: Array.isArray(wp0.images) ? wp0.images : [], dayImage: wp0.dayImage || '', nightImage: wp0.nightImage || wp0.image || '' };
      settingsLib.save({ wallpaper: next });
      log.info('壁纸设置迁移：补全壁纸模式与昼夜槽位');
    }
  } catch {}
  // 首次运行：在桌面创建快捷方式（便携版/安装版都适用）
  try {
    if (app.isPackaged) {
      const exe = process.execPath;
      const lnk = path.join(app.getPath('desktop'), '星启 SWUSTMCL.lnk');
      const ico = path.join(path.dirname(exe), 'icon.ico');
      try {
        shell.writeShortcutLink(lnk, 'create', {
          target: exe,
          cwd: path.dirname(exe),
          description: '星启 SWUSTMCL · Minecraft 启动器',
          icon: fs.existsSync(ico) ? ico : exe,
          iconIndex: 0,
        });
        log.info('已创建桌面快捷方式');
      } catch (e) { log.warn('创建桌面快捷方式失败：' + e.message); }
    }
  } catch {}

  createWindow();
  const initialInvite = protocolUrlFromArgs(process.argv);
  if (initialInvite) setTimeout(() => handleProtocolUrl(initialInvite), 600);
  startManifestWatch();
  startUpdateWatch();

  // 显卡偏好：开启过后每次启动重新写入（注册表项会被驱动更新/系统清理抹掉）
  if (settingsLib.all().gpuHighPerf) {
    setTimeout(async () => {
      try {
        const javas = await core.java.detect({ mcDirs: gameDirs().map((d) => d.path) });
        if (!javas.length) return log.info('显卡偏好：未检测到 Java 运行时，暂不写入');
        const r = await core.gpu.applyAll(javas.map((j) => j.path), 'high');
        log.info('显卡偏好：写入 ' + r.applied.length + ' 个 javaw，失败 ' + r.failed.length);
      } catch (e) {
        log.warn('显卡偏好写入失败：' + e.message);
      }
    }, 2500);
  }
});

app.on('window-all-closed', () => {
  // 关闭启动器不结束正在运行的游戏窗口
  app.quit();
});

// ------------------------------------------------------------ 5 分钟版本巡查
async function startManifestWatch() {
  const CHECK_MS = 5 * 60 * 1000;
  let known = settingsLib.all().lastSeenRelease || '';

  const checkOnce = async () => {
    try {
      const manifest = await core.versions.getManifest({ force: true });
      const latest = (manifest && manifest.latest && manifest.latest.release) || '';
      if (!latest) return;
      latestReleaseCache = manifest;
      if (known && latest !== known) {
        log.info(`检测到新的正式版：${latest}`);
        send('manifest:latest', { version: latest, previous: known });
        // 系统通知（可被设置关闭）
        if (settingsLib.all().autoCheck && Notification.isSupported()) {
          const n = new Notification({
            title: '星启 SWUSTMCL',
            body: `Minecraft ${latest} 已发布，点击前往安装`,
            silent: false,
          });
          n.on('click', () => {
            if (win) {
              win.show();
              win.focus();
              send('manifest:latest', { version: latest, previous: known, gotoInstall: true });
            }
          });
          n.show();
        }
      }
      known = latest;
      settingsLib.save({ lastSeenRelease: latest });
    } catch {
      /* 断网时静默，下个周期再试 */
    }
  };

  setTimeout(checkOnce, 4000);
  setInterval(checkOnce, CHECK_MS);
}

// ------------------------------------------------------------ 启动器自更新巡查
function startUpdateWatch() {
  if (!app.isPackaged || !settingsLib.all().autoUpdateCheck) return;
  const run = async () => {
    try {
      const r = await core.updater.check({ silent: true });
      if (r.available) send('update:available', r);
    } catch {}
  };
  setTimeout(run, 15000);
  setInterval(run, 60 * 60 * 1000);
}

// ================================================================ IPC
function gameDirs() {
  return core.dirs.all(settingsLib.all());
}

function requireIdle(field, label) {
  if (busy[field]) throw new Error(`已有${label}任务在进行，请等待完成`);
}

// ---------- 应用 / 窗口 ----------
ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  packaged: app.isPackaged,
  platform: process.platform,
  electron: process.versions.electron,
  node: process.versions.node,
}));

ipcMain.handle('app:state', async () => {
  const s = settingsLib.all();
  return {
    settings: s,
    account: core.account.accountState(),
    authlib: (() => { try { const al = settingsLib.getSecret('authlib'); return al ? { root: al.root, profiles: al.profiles, selected: al.selected } : null; } catch { return null; } })(),
    dirs: gameDirs(),
    gameRunning: gameProcs.size > 0,
    latestRelease: (latestReleaseCache && latestReleaseCache.latest && latestReleaseCache.latest.release) || '',
    version: app.getVersion(),
    gpuFallback: Boolean(s.gpuFallback),
    sysMemory: require('os').totalmem(),
    cfReady: core.content.hasCfKey(),
    accounts: core.accountstore.read(),
  };
});

ipcMain.on('win:minimize', () => win && win.minimize());
ipcMain.on('win:maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('win:close', () => win && win.close());

// ---------- 设置 ----------
ipcMain.handle('settings:save', (_e, patch) => {
  if (!patch || typeof patch !== 'object') throw new Error('参数无效');
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    switch (key) {
      case 'mcDir': {
        const p = path.resolve(String(value || ''));
        if (!fs.existsSync(p)) {
          // 目标目录不存在时自动创建（支持选到任意盘符的新路径）
          fs.mkdirSync(p, { recursive: true });
        }
        if (p === path.resolve(String(settingsLib.all().mcDir))) { out.mcDir = p; break; } // 未变化
        // 防呆：不允许指向启动器自身目录/其子目录（会与 userdata 混套）
        if (p === app.getPath('exe') && false) { /* placeholder */ }
        out.mcDir = p;
        settingsLib.ensureGameDir(); // 立即建好 versions/libraries/assets
        log.info('游戏存储位置已更改：' + p);
        break;
      }
      case 'memory': {
        const n = Number(value);
        const totalMB = Math.floor(require('os').totalmem() / 1048576);
        const cap = Math.max(2048, Math.min(65536, Math.floor((totalMB * 0.9) / 512) * 512));
        if (!Number.isFinite(n) || n < 256 || n > cap) {
          throw new Error('内存分配无效：请填 256~' + cap + ' MB（本机物理内存约 ' + Math.round(totalMB / 1024) + ' GB）');
        }
        out.memory = Math.round(n);
        break;
      }
      case 'downloadThreads': {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 1 || n > 32) throw new Error('并发数无效');
        out.downloadThreads = Math.round(n);
        break;
      }
      case 'downloadSource':
        out.downloadSource = ['auto', 'bmcl', 'mojang'].includes(value) ? value : 'auto';
        break;
      case 'theme':
        out.theme = value === 'light' ? 'light' : 'dark';
        break;
      case 'accent':
        out.accent = value === 'wallpaper' ? 'wallpaper' : 'brand';
        break;
      case 'playerName': {
        const v = String(value || '').trim();
        if (!v || v.length > 32 || /[\\/:*?"<>|]/.test(v)) throw new Error('玩家名无效');
        out.playerName = v;
        break;
      }
      case 'jvmArgs': {
        const v = String(value || '');
        if (v.length > 2000) throw new Error('JVM 参数过长');
        // 只拦截明显危险的前缀，保留用户自由度
        if (/-javaagent:|-agentlib:/i.test(v)) throw new Error('JVM 参数包含不允许的代理注入');
        out.jvmArgs = v;
        break;
      }
      case 'closeAction':
        if (!['ask', 'minimize', 'close'].includes(value)) throw new Error('关闭行为无效');
        out.closeAction = value;
        break;
      case 'dirNames': {
        const src = value && typeof value === 'object' ? value : {};
        const names = {};
        for (const [k, v] of Object.entries(src)) {
          if (typeof k !== 'string' || k.length > 400) continue;
          if (typeof v !== 'string' || !v.trim()) continue;
          names[k] = v.trim().slice(0, 40);
        }
        out.dirNames = names;
        break;
      }
      case 'authlibNames': {
        const src = value && typeof value === 'object' ? value : {};
        const names = {};
        for (const [k, v] of Object.entries(src)) {
          if (typeof k !== 'string' || k.length > 300) continue;
          if (typeof v !== 'string') continue;
          names[k] = v.trim().slice(0, 40);
        }
        out.authlibNames = names;
        break;
      }
      case 'wallpaper': {
        const value0 = value || {};
        const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
        const image = wall.exists(value0.image) ? String(value0.image) : '';
        const imageLight = wall.exists(value0.imageLight) ? String(value0.imageLight) : '';
        const dayImage = wall.exists(value0.dayImage) ? String(value0.dayImage) : '';
        const nightImage = wall.exists(value0.nightImage) ? String(value0.nightImage) : '';
        const images = Array.isArray(value0.images) ? value0.images.filter((n) => wall.exists(n)).slice(0, 30) : [];
        out.wallpaper = {
          enabled: Boolean(value0.enabled), // 未设置自定义图时使用内置默认壁纸，同样应视为启用
          mode: value0.mode === 'slideshow' ? 'slideshow' : 'daynight',
          intervalMin: Math.min(120, Math.max(1, num(value0.intervalMin, 10))),
          images,
          dayImage,
          nightImage,
          image,
          imageLight,
          fit: ['cover', 'contain', 'stretch'].includes(value0.fit) ? value0.fit : 'cover',
          mask: ['none', 'soft', 'top', 'bottom', 'vignette'].includes(value0.mask) ? value0.mask : 'soft',
          opacity: Math.min(1, Math.max(0.05, num(value0.opacity, 0.6))),
          blur: Math.min(40, Math.max(0, Math.round(num(value0.blur, 0)))),
          dim: Math.min(0.85, Math.max(0, num(value0.dim, 0.35))),
          ui: Math.min(1, Math.max(0.35, num(value0.ui, 0.78))),
        };
        break;
      }
      case 'saveGroup':
        if (!['folder', 'version', 'time'].includes(value)) throw new Error('存档分组方式无效');
        out.saveGroup = value;
        break;
      case 'cfApiKey': {
        const v = String(value || '').trim();
        if (v.length > 200) throw new Error('API Key 过长');
        out.cfApiKey = v;
        break;
      }
      case 'msClientId': {
        const v = String(value || '').trim();
        if (v && !/^[0-9a-fA-F-]{8,64}$/.test(v)) throw new Error('客户端 ID 格式无效');
        out.msClientId = v;
        break;
      }
      case 'loginMode':
        out.loginMode = value === 'msa' ? 'msa' : 'offline';
        break;
      case 'lastSeenVersion':
        out.lastSeenVersion = String(value || '').slice(0, 32);
        break;
      default:
        out[key] = Boolean(value);
    }
  }
  const next = settingsLib.save(out);
  require('./core/net').setDoh(next.doh);
  send('settings:changed', next);
  return next;
});

// ---------- 游戏目录 ----------
ipcMain.handle('dirs:list', async () => {
  const dirs = gameDirs();
  return dirs.map((d) => ({ ...d, instances: core.versions.listInstalled([d]).length }));
});

ipcMain.handle('dirs:add', async () => {
  const r = await dialog.showOpenDialog(win, { title: '选择 .minecraft 或实例根目录', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  const p = r.filePaths[0];
  const s = settingsLib.all();
  const extra = Array.from(new Set([...(s.extraDirs || []), p]));
  settingsLib.save({ extraDirs: extra });
  return gameDirs();
});

ipcMain.handle('dirs:remove', (_e, payload) => {
  const p = path.resolve(String((payload && payload.path) || ''));
  const s = settingsLib.all();
  settingsLib.save({ extraDirs: (s.extraDirs || []).filter((x) => path.resolve(x) !== p) });
  return gameDirs();
});

// ---------- Java ----------
ipcMain.handle('java:detect', async () => {
  const dirs = gameDirs();
  const s = settingsLib.all();
  const list = await core.java.detect({
    mcDirs: dirs.map((d) => d.path),
    extraDirs: s.extraDirs || [],
    preferred: s.javaPath,
  });
  return list;
});

// ---------- 版本清单 / 已安装 ----------
ipcMain.handle('versions:manifest', async (_e, opts = {}) => {
  const manifest = await core.versions.getManifest({ force: Boolean(opts.force) });
  const type = String(opts.type || 'release');
  let list = manifest.versions || [];
  if (type === 'old') list = list.filter((v) => v.type === 'old_beta' || v.type === 'old_alpha');
  else if (type !== 'all') list = list.filter((v) => v.type === type);
  return {
    latest: manifest.latest || {},
    source: manifest.__source || '',
    versions: list.slice(0, 2000).map((v) => ({ id: v.id, type: v.type, releaseTime: v.releaseTime, url: v.url })),
  };
});

ipcMain.handle('versions:installed', async () => {
  const list = core.versions.listInstalled(gameDirs());
  return list;
});

let sizesRunning = false;
ipcMain.handle('versions:sizes', async () => {
  // 后台补齐体积：串行 + 异步遍历（不阻塞主进程），进行中跳过重复请求
  if (sizesRunning) return true;
  sizesRunning = true;
  try {
    const list = core.versions.listInstalled(gameDirs());
    for (const v of list) {
      try {
        const size = await core.versions.dirSize(path.join(v.dir, 'versions', v.id));
        send('versions:size', { dir: v.dir, id: v.id, size });
      } catch {} // 单个实例失败不能中断整轮推送
      await new Promise((r) => setTimeout(r, 30)); // 给其它 IPC 让路
    }
  } finally {
    sizesRunning = false;
  }
  return true;
});

ipcMain.handle('version:command', (_e, payload) => {
  const id = core.safe.assertVersionId(String((payload && payload.id) || ''));
  const dir = String((payload && payload.dir) || settingsLib.all().mcDir);
  const built = core.launch.build(id, { sourceDir: dir });
  return built.command;
});

ipcMain.handle('version:delete', async (_e, payload) => {
  const id = core.safe.assertVersionId(String((payload && payload.id) || ''));
  const dir = String((payload && payload.dir) || '');
  if (!dir) throw new Error('缺少游戏目录');
  const instDir = core.safe.safeJoin(path.join(dir, 'versions'), id);
  if (!fs.existsSync(instDir)) {
    // 已被删除（例如上一次其实成功但回报失败）：直接返回，让列表刷新掉它
    return { ok: true, alreadyGone: true };
  }
  try {
    // Electron 的 shell.trashItem 成功时 resolve(undefined)，失败才抛异常
    await shell.trashItem(instDir);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/ENOENT|找不到|does not exist/i.test(msg)) return { ok: true, alreadyGone: true };
    throw new Error('移入回收站失败：文件可能被游戏、杀毒软件或资源管理器占用，关闭后重试');
  }
  log.info('实例已移入回收站：' + id);
  return { ok: true };
});

// ---------- 安装 ----------
ipcMain.handle('install:start', async (_e, payload) => {
  const id = core.safe.assertVersionId(String((payload && payload.id) || ''));
  const url = String((payload && payload.url) || '');
  if (!core.safe.isHttpUrl(url)) throw new Error('版本元数据地址无效');
  requireIdle('install', '安装');
  busy.install = id;
  const source = settingsLib.all().downloadSource || 'bmcl';
  try {
    const r = await core.install.install(id, { url }, source, (p) => send('install:progress', p));
    return r;
  } finally {
    busy.install = null;
  }
});

// ---------- 修复 ----------
ipcMain.handle('game:repair', async (_e, payload) => {
  const id = core.safe.assertVersionId(String((payload && payload.id) || ''));
  const dir = String((payload && payload.dir) || settingsLib.all().mcDir);
  requireIdle('install', '修复');
  busy.install = `repair:${id}`;
  const report = (p) => send('install:progress', { id, stage: 'repair', ...p });
  try {
    report({ message: '正在体检…', percent: 5 });
    const c = core.repair.check(dir, id);
    if (c.ok) {
      report({ stage: 'done', message: '依赖完整，无需修复', percent: 100 });
      return { ok: true, fixed: 0, remaining: [] };
    }
    report({ message: `发现 ${c.missing.length} 个缺失/损坏文件`, percent: 15 });
    const r = await core.repair.fix(dir, id, (p) => report({ message: `补全文件 ${p.done}/${p.total}`, percent: 15 + Math.round((p.done / Math.max(1, p.total)) * 85) }));
    report({ stage: 'done', message: r.remaining.length ? `仍有 ${r.remaining.length} 个未补齐` : '修复完成', percent: 100 });
    return { ok: r.remaining.length === 0, fixed: r.fixed, remaining: r.remaining };
  } finally {
    busy.install = null;
  }
});

// ---------- 启动 ----------
/** 首次启动前写入中文语言（options.txt 里已有非英语选择则尊重） */
function ensureChineseLanguage(gameDir) {
  try {
    const f = path.join(gameDir, 'options.txt');
    let text = '';
    let exists = true;
    try { text = fs.readFileSync(f, 'utf8'); } catch { exists = false; }
    if (exists) {
      const m = text.match(/^lang:(.+)$/m);
      // 已有明确语言（非默认 en_us）→ 用户自己选过，不动
      if (m && m[1].trim() && m[1].trim() !== 'en_us') return;
    }
    const next = exists
      ? (text.replace(/^lang:.*$/m, 'lang:zh_cn').replace(/\r?\n?$/, '\n'))
      : 'lang:zh_cn\n';
    fs.writeFileSync(f, next, 'utf8');
  } catch {}
}

/** 游戏窗口出现后拉到前台（javaw 启动到出窗口有延迟，多次尝试） */
function focusGameWindow(tries = 6) {
  const cp = require('child_process');
  const script = "$p = Get-Process javaw,java -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object StartTime -Descending | Select-Object -First 1; if ($p) { (New-Object -ComObject WScript.Shell).AppActivate($p.Id) | Out-Null; Write-Output 'ok' } else { Write-Output 'no' }";
  let n = 0;
  const tick = () => {
    n += 1;
    cp.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000 }, (_err, stdout) => {
      if (String(stdout || '').includes('ok') && win && !win.isDestroyed() && !win.isMinimized()) {
        setTimeout(() => { try { win.minimize(); } catch {} }, 400);
      }
    });
    if (n < tries && gameProcs.size) setTimeout(tick, 3000);
  };
  setTimeout(tick, 2500);
}

ipcMain.handle('game:launch', async (_e, payload) => {
  const id = core.safe.assertVersionId(String((payload && payload.id) || ''));
  const dir = String((payload && payload.dir) || '');
  const joinServer = payload && payload.server && payload.server.host ? { host: String(payload.server.host), port: Number(payload.server.port) || 25565 } : null;
  // 允许多开：不同实例、甚至同一实例都可以再启动一个窗口
  const s = settingsLib.all();
  const launchDomain = activeSiteDomain();
  const launchDomainRoot = activeDomainRoot();
  if (launchDomain) {
    const al = settingsLib.getSecret('authlib');
    if (!launchDomainRoot || !al || !al.selected || normalizeDomainRoot(al.root) !== launchDomainRoot) {
      throw new Error('当前处于「' + (launchDomain.name || '站点域') + '」，请先在账户页登录该域对应的皮肤站账号再启动游戏');
    }
  }
  const meta = core.versions.loadVersionJson(dir, id);
  let packMinJava = 0;
  try {
    const marker = core.domainpacks.readMarker(path.join(dir || settingsLib.ensureGameDir(), 'versions', id));
    packMinJava = Number(marker.minJava) || 0;
  } catch {}

  // 启动前体检：库/资源缺失会自动补全（否则 Fabric 等加载器会 ClassNotFoundException）
  try {
    const pre = core.repair.check(dir, id);
    if (!pre.ok) {
      log.info(`启动前体检：缺 ${pre.missing.length} 个文件，自动补全…`);
      send('install:progress', { id, stage: 'preflight', message: '启动前补全缺失依赖…', percent: 1 });
      await core.repair.fix(dir, id, (p) => {
        const pct = Math.min(99, Math.round((p.done / Math.max(1, p.total)) * 100));
        send('install:progress', { id, stage: 'preflight', message: `补全依赖 ${p.done}/${p.total}`, percent: pct });
      }, s.downloadSource === 'mojang' ? 'mojang' : 'bmcl');
      const after = core.repair.check(dir, id);
      if (!after.ok) {
        throw new Error(`实例依赖不完整（仍缺 ${after.missing.length} 个文件），自动补全未成功——请到「版本管理 → 体检」检查网络后重试`);
      }
      send('install:progress', { id, stage: 'done', message: '依赖已补全', percent: 100 });
    }
  } catch (e) {
    if (String(e.message).includes('实例依赖不完整')) throw e;
    log.warn('启动前体检失败（不阻塞启动）：' + e.message);
  }

  // Java：按版本要求自动挑选
  let javaPath = s.javaPath;
  if (javaPath && packMinJava) {
    const info = await core.java.runJavaVersion(javaPath).catch(() => null);
    if (!info || info.major < packMinJava) {
      throw new Error(`该整合包要求 Java ${packMinJava}+，当前指定的 Java 版本过低，请到实例设置或「设置 → Java」更换`);
    }
  }
  if (!javaPath) {
    const javas = await core.java.detect({ mcDirs: gameDirs().map((d) => d.path), preferred: '' });
    const required = Math.max((meta.javaVersion && meta.javaVersion.majorVersion) || 8, packMinJava);
    const picked = core.java.pick(javas, required);
    if (!picked) {
      // 自动下载缺失的 Java 运行时（清华 Adoptium 镜像优先，任务卡可见）
      if (settingsLib.all().autoDownloadJava !== false) {
        log.info(`未找到 Java ${required}，自动下载运行时…`);
        send('java:progress', { stage: 'download', message: `下载 Java ${required} 运行时…`, percent: 0 });
        const exe = await core.javainstall.ensureJava(required, (p) => send('java:progress', { ...p, major: required }));
        javaPath = exe;
        log.info(`Java ${required} 就绪：${exe}`);
      } else {
        throw new Error(`未找到 Java ${required}。请在「设置 → Java」里确认检测结果或手动指定路径（也可开启「自动下载缺失 Java」）。`);
      }
    } else {
      javaPath = picked.path;
    }
  }

  // 账号：正版续期 / 皮肤站注入
  let account = null;
  let authlibJar = '';
  if (s.loginMode === 'msa') {
    account = await core.account.ensureFreshToken();
  } else if (s.loginMode === 'authlib') {
    const al = settingsLib.getSecret('authlib');
    if (!al || !al.selected) throw new Error('皮肤站账号未登录或未选择角色，请到账号管理重新登录');
    authlibJar = await core.authlib.ensureInjector();
    account = {
      mode: 'authlib',
      accessToken: al.accessToken,
      name: al.selected.name,
      uuid: al.selected.id,
      root: al.root,
    };
  }

  // 内存：自动分配（物理内存 35%，2048~8192 取整）或用户设定
  const memoryMB = s.autoMemory ? core.memory.autoMemoryFromUsage() : s.memory;
  // 启动前自动优化内存（整理工作集，失败不阻塞启动）
  if (s.autoFreeMemory) {
    try {
      log.info('启动前内存优化：整理中…');
      const fr = await core.memory.freeWorkingSets(12000);
      if (fr && fr.ok) log.info('启动前内存优化完成：整理 ' + fr.processes + ' / ' + (fr.total || fr.processes) + ' 个进程工作集');
      else log.warn('启动前内存优化未完成（' + ((fr && fr.error) || '超时') + '），继续启动');
    } catch (e) {
      log.warn('启动前内存优化失败：' + e.message + '，继续启动');
    }
  }
  const options = {
    sourceDir: dir,
    memory: memoryMB,
    authlibJar,
    playerName: s.playerName,
    javaPath,
    account,
    jvmArgs: s.jvmArgs,
    fullscreen: s.fullscreen,
    resolution: s.resolution,
    ...(joinServer ? { server: joinServer } : {}),
  };

  log.info(`启动游戏：${id}（隔离=${core.dirs.isIsolatedInstance(core.safe.safeJoin(path.join(dir, 'versions'), id)) ? '是' : '否'}，内存 ${s.memory}M）`);

  // 启动前确保中文（MC 只在启动时读 options.txt）
  try {
    const instDir0 = core.safe.safeJoin(path.join(dir, 'versions'), id);
    ensureChineseLanguage(core.dirs.isIsolatedInstance(instDir0) ? instDir0 : dir);
  } catch {}

  const sessionId = id + '#' + Date.now();
  const sessionStart = Date.now();
  const proc = core.launch.launch(id, options, {
    onLog: (line, isErr) => {
      log.game(line, isErr);
      core.instancelog.append(id, line); // 每个实例的日志各自归档
    },
    onExit: (code) => {
      log.info(`游戏进程退出：${id}，退出码 ${code}`);
      core.history.record({ id, dir, start: sessionStart, end: Date.now() });
      gameProcs.delete(sessionId);
      send('game:exit', { id, pid: proc.pid || 0, code, running: gameProcs.size });
    },
    onError: (err) => {
      log.error(`游戏进程错误（${id}）：${err.message}`);
      gameProcs.delete(sessionId);
      send('game:error', { message: err.message, id, pid: proc.pid || 0, running: gameProcs.size });
    },
  });
  gameProcs.set(sessionId, { id, dir, start: sessionStart, proc });

  send('game:started', { id, pid: proc.pid, gameDir: proc.gameDir, isolated: proc.isolated, running: gameProcs.size });
  try { focusGameWindow(); } catch {}
  return { ok: true, pid: proc.pid, isolated: proc.isolated };
});

ipcMain.handle('game:kill', async (_e, payload) => {
  const wantPid = Number(payload && payload.pid) || 0;
  if (!gameProcs.size) return { ok: false };
  let killed = 0;
  for (const [sid, rec] of gameProcs.entries()) {
    if (wantPid && rec.proc.pid !== wantPid) continue;
    try { rec.proc.child.kill(); killed += 1; gameProcs.delete(sid); } catch {}
  }
  return { ok: killed > 0, killed };
});

// ---------- 存档 ----------
ipcMain.handle('saves:list', async () => {
  const dirs = gameDirs();
  const result = await core.saves.scan(dirs, (done, total) => send('saves:progress', { done, total }));
  return result;
});

ipcMain.handle('saves:reveal', async (_e, payload) => {
  const p = String((payload && payload.path) || '');
  const st = fs.statSync(p); // 不存在会抛错
  if (!st.isDirectory()) throw new Error('路径无效');
  shell.openPath(p);
  return true;
});

ipcMain.handle('saves:trash', async (_e, payload) => {
  const p = String((payload && payload.path) || '');
  const st = fs.statSync(p);
  if (!st.isDirectory()) throw new Error('路径无效');
  const r = await dialog.showMessageBox(win, {
    type: 'warning',
    title: '移至回收站',
    message: '确定把这个存档移至回收站吗？',
    detail: p,
    buttons: ['移入回收站', '取消'],
    defaultId: 0,
    cancelId: 1,
  });
  if (r.response !== 0) return { ok: false };
  const moved = await shell.trashItem(p);
  if (!moved) throw new Error('移入回收站失败——文件可能被占用，请关闭相关程序后重试');
  log.info(`存档已移入回收站：${path.basename(p)}`);
  return { ok: true };
});

// ---------- 加载器 ----------
ipcMain.handle('loader:list', async (_e, payload) => {
  const loader = String((payload && payload.loader) || '');
  const mc = core.safe.assertVersionId(String((payload && payload.mc) || ''), '游戏版本');
  return core.loaders.listLoaderVersions(loader, mc);
});

ipcMain.handle('loader:install', async (_e, payload) => {
  const loader = String((payload && payload.loader) || '');
  const mc = core.safe.assertVersionId(String((payload && payload.mc) || ''), '游戏版本');
  const loaderVersion = String((payload && payload.loaderVersion) || '');
  const instanceId = payload && payload.instanceId ? core.safe.assertVersionId(String(payload.instanceId)) : '';
  requireIdle('loader', '加载器安装');
  busy.loader = loader;
  const source = settingsLib.all().downloadSource || 'bmcl';
  try {
    const r = await core.loaders.install(loader, mc, loaderVersion, instanceId, source, (p) => send('loader:progress', { loader, ...p }));
    return r;
  } finally {
    busy.loader = null;
  }
});

// ---------- 整合包 ----------
ipcMain.handle('modpack:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择整合包 zip',
    properties: ['openFile'],
    filters: [{ name: '整合包', extensions: ['zip'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

ipcMain.handle('modpack:inspect', (_e, payload) => {
  const file = String((payload && payload.file) || '');
  return core.modpack.inspect(file);
});

ipcMain.handle('modpack:install', async (_e, payload) => {
  const file = String((payload && payload.file) || '');
  const info = core.modpack.inspect(file);
  requireIdle('modpack', '整合包导入');
  busy.modpack = info.name;
  try {
    const r = await core.modpack.importPack(file, info, {
      onProgress: (p) => send('modpack:progress', { name: info.name, ...p }),
      installVanilla: async (mc, onProgress) => {
        const manifest = await core.versions.getManifest();
        const entry = (manifest.versions || []).find((v) => v.id === mc);
        if (!entry) throw new Error(`版本清单里找不到 ${mc}`);
        return core.install.install(mc, entry, settingsLib.all().downloadSource || 'bmcl', onProgress);
      },
      installLoader: async (loader, mc, lv, instanceId, onProgress) => {
        await core.loaders.install(loader, mc, lv, instanceId, settingsLib.all().downloadSource || 'bmcl', onProgress);
      },
    });
    // 校验依赖完整性
    if (r.id) {
      const c = core.repair.check(settingsLib.all().mcDir, r.id);
      r.dependencies = { ok: c.ok, missing: c.missing.length };
    }
    return r;
  } finally {
    busy.modpack = null;
  }
});

// ---------- 整合包导出 ----------
ipcMain.handle('pack:exportPlan', (_e, payload) => {
  const id = core.safe.assertVersionId(String((payload && payload.id) || ''));
  const dir = String((payload && payload.dir) || '');
  return core.modpack.exportPlan(settingsLib.all().mcDir, id, dir);
});

ipcMain.handle('pack:exportPick', async (_e, payload) => {
  const r = await dialog.showSaveDialog(win, {
    title: '导出整合包',
    defaultPath: `${(payload && payload.defaultName) || 'modpack'}.zip`,
    filters: [{ name: '整合包', extensions: ['zip'] }],
  });
  if (r.canceled) return null;
  return r.filePath;
});

ipcMain.handle('pack:export', async (_e, payload) => {
  const id = core.safe.assertVersionId(String((payload && payload.id) || ''));
  const dest = String((payload && payload.dest) || '');
  if (!dest.toLowerCase().endsWith('.zip')) throw new Error('导出文件必须是 zip');
  const dir = String((payload && payload.dir) || '');
  // dir = payload.dir（游戏根，与计划阶段一致）；exportPack 内部拼 versions
  const root = String((payload && payload.dir) || '') || settingsLib.all().mcDir;
  const r = await core.modpack.exportPack(root, id, dest, (p) => send('pack:exportProgress', { id, ...p }), dir);

  log.info(`整合包已导出：${dest}`);
  return r;
});

// ---------- 资源（Modrinth / CurseForge） ----------
ipcMain.handle('translation:stats', () => core.translation.stats());

ipcMain.handle('content:chineseAlias', async (_e, payload) => {
  const q = String((payload && payload.query) || '').trim();
  if (!/[\u4e00-\u9fa5]/.test(q)) return [];
  try { return await core.content.chineseAlias(q); } catch (e) { log.warn('MC百科 译名查询失败: ' + e.message); return []; }
});

ipcMain.handle('content:search', (_e, payload) => core.content.search(payload || {}));
ipcMain.handle('content:versions', (_e, payload) => core.content.versions(payload.source || 'modrinth', payload.projectId, payload || {}));

ipcMain.handle('content:install', async (_e, payload) => {
  requireIdle('content', '资源安装');
  busy.content = payload.projectId;
  try {
    return await core.content.install(payload, (p) => send('content:progress', { projectId: payload.projectId, source: payload.source, ...p }));
  } finally {
    busy.content = null;
  }
});

// ---------- 账号 ----------
ipcMain.handle('auth:status', () => core.account.accountState());

ipcMain.handle('auth:login', async () => {
  try {
    const r = await core.account.loginDeviceCode((stage) => send('auth:stage', stage));
    send('auth:done', r);
    return r;
  } catch (e) {
    send('auth:failed', { message: e.message });
    throw e;
  }
});

ipcMain.on('auth:cancel', () => core.account.cancelLogin());

ipcMain.on('auth:logout', () => {
  core.account.logout();
  send('auth:done', { name: null });
});

// ---------- 多账户管理 ----------
ipcMain.handle('accounts:list', async () => {
  const store = core.accountstore.read();
  const s = settingsLib.all();
  const list = store.list.slice();
  // 兜底：激活的是离线模式但列表里还没有对应条目（旧配置迁移）时补一个
  if (s.loginMode === 'offline') {
    const uid = 'offline-' + (s.playerName || 'Steve').toLowerCase();
    if (!list.some((a) => a.uid === uid)) {
      list.push({ uid, type: 'offline', name: s.playerName || 'Steve', uuid: core.launch.offlineUuid(s.playerName || 'Steve'), payload: {} });
    }
  }
  return { list, activeId: store.activeId || (s.loginMode === 'offline' ? 'offline-' + (s.playerName || 'Steve').toLowerCase() : '') };
});

ipcMain.handle('accounts:addOffline', async (_e, payload) => {
  assertAccountAllowedInDomain(null);
  const name = String((payload && payload.name) || '').trim();
  if (!name || name.length > 32 || /[\\/:*?"<>|]/.test(name)) throw new Error('玩家名无效');
  const uid = 'offline-' + name.toLowerCase();
  core.accountstore.upsert({ uid, type: 'offline', name, uuid: core.launch.offlineUuid(name), payload: {} });
  core.accountstore.setActive(uid);
  settingsLib.save({ loginMode: 'offline', playerName: name });
  log.info('已添加离线账户：' + name);
  return core.account.accountState();
});

ipcMain.handle('accounts:switch', async (_e, payload) => {
  const uid = String((payload && payload.uid) || '');
  const store = core.accountstore.read();
  const entry = store.list.find((a) => a.uid === uid);
  if (!entry) throw new Error('账户不存在');
  assertAccountAllowedInDomain(entry);
  if (entry.type === 'offline') {
    settingsLib.save({ loginMode: 'offline', playerName: entry.name });
  } else if (entry.type === 'msa') {
    settingsLib.setSecret('msa', entry.payload);
    settingsLib.save({ loginMode: 'msa', playerName: entry.name });
  } else if (entry.type === 'authlib') {
    settingsLib.setSecret('authlib', entry.payload);
    settingsLib.save({ loginMode: 'authlib' });
    // 旧账户没有保存皮肤直链：切换时后台 refresh 一次，从 textures 属性补全
    if (!entry.payload.skinUrl && entry.payload.root && entry.payload.accessToken && entry.payload.selected) {
      try {
        const rr = await core.authlib.selectProfile(entry.payload.root, entry.payload.accessToken, entry.payload.selected.id);
        const np = { ...entry.payload, accessToken: rr.accessToken, selected: rr.selected, skinUrl: (rr.selected && rr.selected.skinUrl) || '' };
        core.accountstore.upsert({ ...entry, payload: np });
        settingsLib.setSecret('authlib', np);
        if (entry.uuid) core.account.clearAvatarCache(entry.uuid, entry.name);
      } catch {}
    }
  }
  core.accountstore.setActive(uid);
  log.info('已切换账户：' + entry.name);
  return core.account.accountState();
});

ipcMain.handle('accounts:remove', async (_e, payload) => {
  const uid = String((payload && payload.uid) || '');
  const store = core.accountstore.read();
  const entry = store.list.find((a) => a.uid === uid);
  const wasActive = store.activeId === uid;
  const inDomain = Boolean(activeSiteDomain());
  const domainRoot = activeDomainRoot();
  const nextActive = core.accountstore.remove(uid);
  // 若删除的是激活账户：域内优先回落到同一皮肤站账户，个人域回落到列表下一个
  if (wasActive) {
    const remaining = core.accountstore.list();
    const next = inDomain
      ? remaining.find((a) => a.type === 'authlib' && domainRoot && normalizeDomainRoot(a.payload && a.payload.root) === domainRoot)
      : remaining.find((a) => a.uid === nextActive);
    if (!next) {
      core.accountstore.setActive('');
      settingsLib.save({ loginMode: inDomain ? 'authlib' : 'offline' });
      if (inDomain) {
        settingsLib.setSecret('authlib', null);
        settingsLib.setSecret('msa', null);
      }
    } else if (next.type === 'msa') {
      core.accountstore.setActive(next.uid);
      settingsLib.setSecret('msa', next.payload);
      settingsLib.save({ loginMode: 'msa', playerName: next.name });
    } else if (next.type === 'authlib') {
      core.accountstore.setActive(next.uid);
      settingsLib.setSecret('authlib', next.payload);
      settingsLib.save({ loginMode: 'authlib' });
    } else {
      core.accountstore.setActive(next.uid);
      settingsLib.save({ loginMode: 'offline', playerName: next.name });
    }
  }
  if (entry && entry.type === 'msa') { /* 令牌随 safeStorage 覆盖自然失效 */ }
  log.info('已移除账户：' + (entry ? entry.name : uid));
  return { activeId: core.accountstore.activeId() || '' };
});

ipcMain.handle('avatar:get', async (_e, payload) => {
  const uuid = String((payload && payload.uuid) || '');
  const name = String((payload && payload.name) || '');
  const force = Boolean(payload && payload.force);
  // 从账户库找到该角色保存的皮肤直链（登录/换角色时解析）
  let hintSkinUrl = '';
  try {
    const entry = core.accountstore.read().list.find((a) => a.type === 'authlib' && ((a.uuid && a.uuid === uuid) || (a.name && a.name === name)));
    hintSkinUrl = (entry && entry.payload && entry.payload.skinUrl) || '';
  } catch {}
  const r = await core.account.fetchSkinTexture(uuid, name, force, hintSkinUrl);
  return { file: r.file, dataUrl: r.dataUrl, cached: r.cached };
});

ipcMain.handle('skin:import', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择皮肤 PNG',
    properties: ['openFile'],
    filters: [{ name: '皮肤', extensions: ['png'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const state = core.account.accountState();
  return core.account.importLocalSkin(state.name, r.filePaths[0]);
});

ipcMain.handle('skin:clear', () => {
  const state = core.account.accountState();
  const f = core.account.localSkinFile(state.name);
  if (f) fs.unlinkSync(f);
  core.account.clearAvatarCache(state.uuid, state.name);
  return true;
});

ipcMain.handle('skin:local', (_e, payload) => {
  const name = String((payload && payload.name) || settingsLib.all().playerName);
  return core.account.localSkinFile(name);
});

// ---------- 对话框 / 打开 ----------
ipcMain.handle('dialog:pickDir', async () => {
  const r = await dialog.showOpenDialog(win, { title: '选择目录', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

ipcMain.handle('dialog:pickDirNew', async () => {
  const r = await dialog.showOpenDialog(win, { title: '选择或新建游戏存储目录', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

ipcMain.handle('dialog:pickJava', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择 javaw.exe',
    properties: ['openFile'],
    filters: [{ name: 'Java', extensions: ['exe'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const p = r.filePaths[0];
  if (!/(javaw?\.exe)$/i.test(p)) throw new Error('请选择 java.exe 或 javaw.exe');
  return p;
});

ipcMain.handle('clipboard:write', (_e, payload) => {
  const text = typeof payload === 'string' ? payload : String((payload && payload.text) || '');
  clipboard.writeText(text);
  return true;
});

ipcMain.handle('clipboard:read', () => { const t = clipboard.readText() || ''; return t; });

ipcMain.handle('open:path', (_e, payload) => {
  const target = String((payload && payload.target) || '');
  const st = fs.existsSync(target) ? fs.statSync(target) : null;
  if (!st) throw new Error('路径不存在');
  // 只允许打开目录（或目录内的文件所在目录），避免被当成任意文件执行器
  const dir = st.isDirectory() ? target : path.dirname(target);
  shell.openPath(dir);
  return true;
});

ipcMain.handle('open:url', (_e, payload) => {
  const url = String((payload && payload.url) || '');
  if (!core.safe.isHttpUrl(url, core.safe.PAGE_HOSTS)) throw new Error('链接不在允许范围内');
  shell.openExternal(url);
  return true;
});

// ---------- 实例资源（资源包 / 光影 / 截图） ----------
ipcMain.handle('instance:assets', (_e, payload) => {
  const dir = String((payload && payload.dir) || settingsLib.all().mcDir);
  const id = core.safe.assertVersionId(String((payload && payload.id) || ''));
  return core.instanceassets.list(dir, id, String((payload && payload.kind) || ''), true);
});

ipcMain.handle('instance:asset:trash', async (_e, payload) => {
  const p = core.instanceassets.assertTrashable(String((payload && payload.path) || ''));
  const ok = await shell.trashItem(p);
  if (!ok) throw new Error('移入回收站失败——文件可能被占用');
  return true;
});

// ---------- 服务器列表（首页） ----------
ipcMain.handle('servers:list', () => core.servers.list());
ipcMain.handle('servers:ping', (_e, payload) => core.servers.ping(String((payload && payload.host) || ''), Number((payload && payload.port) || 25565)));
ipcMain.handle('servers:save', (_e, payload) => core.servers.saveOne(payload || {}));
ipcMain.handle('servers:remove', (_e, id) => core.servers.remove(String(id || '')));

// ---------- 启动器域 ----------
ipcMain.handle('domains:list', () => core.domains.list());
ipcMain.handle('domains:state', () => core.domains.state());
ipcMain.handle('domains:setActive', async (_e, payload) => {
  const target = String((payload && payload.id) || 'personal');
  const before = core.domains.active();
  if (before.id === 'personal') {
    const currentId = core.accountstore.activeId();
    if (currentId) settingsLib.save({ personalAccountId: currentId });
  }
  const state = core.domains.setActive(target);
  const domain = core.domains.active();
  const normalizeRoot = (value) => String(value || '').replace(/\/+$/, '');
  let accountEntry = null;
  if (domain.personal) {
    const savedId = settingsLib.all().personalAccountId || '';
    accountEntry = core.accountstore.list().find((a) => a.uid === savedId) || null;
  } else {
    const root = normalizeRoot(domain.manifest && domain.manifest.auth && domain.manifest.auth.yggdrasilUrl);
    accountEntry = core.accountstore.list().find(
      (a) => a.type === 'authlib' && normalizeRoot(a.payload && a.payload.root) === root
    ) || null;
  }
  if (accountEntry) {
    if (accountEntry.type === 'offline') {
      settingsLib.save({ loginMode: 'offline', playerName: accountEntry.name });
    } else if (accountEntry.type === 'msa') {
      settingsLib.setSecret('msa', accountEntry.payload);
      settingsLib.save({ loginMode: 'msa', playerName: accountEntry.name });
    } else if (accountEntry.type === 'authlib') {
      settingsLib.setSecret('authlib', accountEntry.payload);
      settingsLib.save({ loginMode: 'authlib' });
    }
    core.accountstore.setActive(accountEntry.uid);
  } else {
    core.accountstore.setActive('');
    settingsLib.setSecret('authlib', null);
    settingsLib.setSecret('msa', null);
    settingsLib.save({ loginMode: domain.personal ? 'offline' : 'authlib' });
  }
  log.info('已切换域：' + (domain.name || domain.id));
  return { state, account: core.account.accountState(), cfReady: core.content.hasCfKey() };
});
ipcMain.handle('domains:add', (_e, payload) => {
  rememberPersonalAccount();
  return core.domains.add(String((payload && payload.input) || ''));
});
ipcMain.handle('domains:remove', (_e, payload) => core.domains.remove(String((payload && payload.id) || '')));
ipcMain.handle('domains:refresh', (_e, payload) => core.domains.refresh(String((payload && payload.id) || '')));
ipcMain.handle('domainpacks:scan', async (_e, payload) => {
  const scan = await core.domainpacks.scanInstance(
    String((payload && payload.dir) || ''),
    String((payload && payload.id) || '')
  );
  const { versionJson, ...instance } = scan.instance;
  const instanceDir = path.join(String((payload && payload.dir) || ''), 'versions', String((payload && payload.id) || ''));
  const marker = core.domainpacks.readMarker(instanceDir);
  const activeDomain = core.domains.active();
  const sameDomain = marker.packId && marker.domainId === activeDomain.id;
  return {
    instance,
    fileCount: scan.files.length,
    totalSize: scan.totalSize,
    marker: sameDomain ? {
      packId: marker.packId,
      packName: marker.packName || '',
      version: Number(marker.version) || 0,
      minJava: Number(marker.minJava) || 0,
      policy: marker.policy || '',
      serverId: marker.serverId || '',
    } : null,
  };
});
ipcMain.handle('domainpacks:publish', async (_e, payload) => {
  return core.domainpacks.publish({
    domainId: String((payload && payload.domainId) || ''),
    dir: String((payload && payload.dir) || ''),
    instanceId: String((payload && payload.instanceId) || ''),
    serverId: String((payload && payload.serverId) || ''),
    policy: String((payload && payload.policy) || 'optional'),
    minJava: Number((payload && payload.minJava) || 0),
    notes: String((payload && payload.notes) || ''),
    name: String((payload && payload.name) || ''),
    description: String((payload && payload.description) || ''),
    onProgress: (progress) => send('domainpacks:progress', progress),
  });
});
ipcMain.handle('domainpacks:install', async (_e, payload) => {
  const mode = String((payload && payload.mode) || 'pack');
  const onProgress = (progress) => send('domainpacks:progress', progress);
  if (mode === 'vanilla') {
    return core.domainpacks.installVanilla({
      mcVersion: String((payload && payload.mcVersion) || ''),
      onProgress,
    });
  }
  return core.domainpacks.installPack({
    domainId: String((payload && payload.domainId) || ''),
    packId: String((payload && payload.packId) || ''),
    serverId: String((payload && payload.serverId) || ''),
    mcDir: String((payload && payload.mcDir) || ''),
    instanceId: String((payload && payload.instanceId) || ''),
    onProgress,
  });
});
ipcMain.handle('domainpacks:tokenStatus', (_e, payload) => ({
  configured: Boolean(core.domainpacks.publishToken(String((payload && payload.domainId) || ''))),
}));
ipcMain.handle('domainpacks:setToken', (_e, payload) => ({
  configured: core.domainpacks.setPublishToken(
    String((payload && payload.domainId) || ''),
    String((payload && payload.token) || '')
  ),
}));
ipcMain.handle('domainpacks:installed', () => {
  const out = [];
  for (const inst of core.versions.listInstalled(gameDirs())) {
    const instanceDir = path.join(inst.dir, 'versions', inst.id);
    const marker = core.domainpacks.readMarker(instanceDir);
    if (!marker || !marker.packId) continue;
    out.push({
      id: inst.id,
      dir: inst.dir,
      mcVersion: inst.mcVersion,
      loader: inst.loader,
      isolated: inst.isolated,
      packId: marker.packId,
      packName: marker.packName || '',
      version: Number(marker.version) || 0,
      minJava: Number(marker.minJava) || 0,
      policy: marker.policy || '',
      serverId: marker.serverId || '',
    });
  }
  return out;
});
ipcMain.handle('domains:downloadResource', async (_e, payload) => {
  const id = String((payload && payload.domainId) || '');
  const resourceId = String((payload && payload.resourceId) || '');
  return core.domains.downloadResource(id, resourceId, (received, total) => {
    send('domains:resourceProgress', { domainId: id, resourceId, received, total });
  });
});
ipcMain.handle('domains:installResource', async (_e, payload) => {
  const id = String((payload && payload.domainId) || '');
  const resourceId = String((payload && payload.resourceId) || '');
  const instanceDir = String((payload && payload.instanceDir) || '');
  return core.domains.installResource(id, resourceId, instanceDir, (received, total) => {
    send('domains:resourceProgress', { domainId: id, resourceId, received, total });
  });
});

// ---------- 游玩历史 / 每实例日志 ----------
ipcMain.handle('history:list', () => core.history.read());
ipcMain.handle('log:instance', (_e, payload) => core.instancelog.tail(String((payload && payload.id) || ''), Number((payload && payload.lines) || 500)));
ipcMain.handle('log:instance:clear', (_e, payload) => core.instancelog.clear(String((payload && payload.id) || '')));

// ---------- 关闭确认（渲染层主题化弹窗）
const mwState = { allowClose: false, promptAt: 0 };
ipcMain.handle('app:close-choice', (_e, payload) => {
  const action = String((payload && payload.action) || '');
  const remember = Boolean(payload && payload.remember);
  if (action === 'cancel' || !action) return { ok: true };
  const act = action === 'minimize' ? 'minimize' : 'close';
  if (remember) {
    try {
      const s = settingsLib.save({ closeAction: act });
      send('settings:changed', s);
    } catch {}
  }
  if (!win || win.isDestroyed()) return { ok: false };
  if (act === 'minimize') win.minimize();
  else { mwState.allowClose = true; win.close(); }
  return { ok: true };
});

// ---------- 壁纸（浅色 / 深色主题各一个槽位，导入与清除只作用于传入的槽位） ----------
ipcMain.handle('wallpaper:pick', async (_e, slot) => {
  const cur = settingsLib.all().wallpaper || {};
  const keepList = [cur.image, cur.imageLight, cur.dayImage, cur.nightImage, ...(cur.images || [])].filter(Boolean);
  const r = await wall.pick(win, keepList);
  if (!r) return null;
  let patch;
  if (slot === 'list') {
    patch = { images: [...new Set([...(cur.images || []), r.name])].slice(0, 30) };
  } else if (slot === 'day') {
    patch = { dayImage: r.name };
  } else if (slot === 'night') {
    patch = { nightImage: r.name };
  } else {
    patch = { imageLight: r.name };
  }
  const s = settingsLib.save({ wallpaper: { ...cur, enabled: true, ...patch } });
  const theme = wall.theme(r.name);
  send('settings:changed', s);
  return { ...r, theme, url: wall.urlFor(r.name) };
});

// 从轮换列表移除一张（并删除文件）
ipcMain.handle('wallpaper:remove', (_e, name) => {
  const n = String(name || '');
  const cur = settingsLib.all().wallpaper || {};
  const images = (cur.images || []).filter((x) => x !== n);
  // 其他槽位仍在引用时不删文件
  const stillUsed = [cur.image, cur.imageLight, cur.dayImage, cur.nightImage, ...images].includes(n);
  if (wall.isManaged(n) && !stillUsed) {
    try { fs.unlinkSync(path.join(wall.root(), n)); } catch {}
  }
  const s = settingsLib.save({ wallpaper: { ...cur, images } });
  send('settings:changed', s);
  return s;
});

ipcMain.handle('wallpaper:clear', (_e, slot) => {
  const cur = settingsLib.all().wallpaper || {};
  const fieldOf = { day: 'dayImage', night: 'nightImage', light: 'imageLight', image: 'image' };
  const field = fieldOf[slot] || 'imageLight';
  const patch = { [field]: '' };
  // 仅当该槽位没有其它图片引用的文件时清理磁盘
  const removed = cur[field];
  const keep = [cur.image, cur.imageLight, cur.dayImage, cur.nightImage, ...(cur.images || [])]
    .filter((x) => x && x !== removed);
  if (removed && !keep.includes(removed)) {
    if (keep.length) wall.prune(keep);
    else wall.clearAll();
  }
  const stillAny = keep.length > 0;
  const s = settingsLib.save({ wallpaper: { ...cur, ...patch, enabled: stillAny && Boolean(cur.enabled) } });
  send('settings:changed', s);
  return s;
});

ipcMain.handle('wallpaper:palette', (_e, payload) => {
  const name = String((payload && payload.image) || '');
  return wall.theme(name);
});

// ---------- 显卡偏好 ----------
// ---------- 实例级管理 ----------
ipcMain.handle('instance:settings:get', (_e, payload) => {
  const dir = String((payload && payload.dir) || '');
  const id = core.safe.assertVersionId(String((payload && payload.id) || ''));
  return core.instances.getSettings(core.safe.safeJoin(path.join(dir, 'versions'), id));
});

ipcMain.handle('instance:settings:save', (_e, payload) => {
  const dir = String((payload && payload.dir) || '');
  const id = core.safe.assertVersionId(String((payload && payload.id) || ''));
  const patch = (payload && payload.patch) || {};
  const instDir = core.safe.safeJoin(path.join(dir, 'versions'), id);
  return core.instances.saveSettings(instDir, patch);
});

ipcMain.handle('instance:rename', async (_e, payload) => {
  const dir = String((payload && payload.dir) || settingsLib.all().mcDir);
  const oldId = core.safe.assertVersionId(String((payload && payload.oldId) || ''));
  const newId = core.safe.assertVersionId(String((payload && payload.newId) || ''));
  return core.instances.renameInstance(dir, oldId, newId);
});

ipcMain.handle('mods:list', async (_e, payload) => {
  const dir = String((payload && payload.dir) || '');
  const id = core.safe.assertVersionId(String((payload && payload.id) || ''));
  return core.instances.listMods(core.safe.safeJoin(path.join(dir, 'versions'), id));
});

ipcMain.handle('mods:toggle', async (_e, payload) => {
  return core.instances.setModEnabled(String(payload.file), Boolean(payload.enabled));
});

ipcMain.handle('mods:delete', async (_e, payload) => {
  return core.instances.deleteMod(String(payload.file));
});

ipcMain.handle('mods:checkUpdate', async (_e, payload) => {
  const gv = String((payload && payload.gameVersion) || '');
  return core.instances.checkModUpdate(String(payload.file), gv);
});

ipcMain.handle('mods:applyUpdate', async (_e, payload) => {
  const url = String((payload && payload.url) || '');
  if (!core.safe.isHttpUrl(url, ['modrinth.com', 'cdn.modrinth.com'])) throw new Error('下载地址不在允许范围内');
  return core.instances.applyModUpdate(String(payload.file), url, String(payload.filename || ''));
});

// ---------- 第三方皮肤站（authlib-injector）----------
ipcMain.handle('authlib:meta', async (_e, payload) => {
  return core.authlib.fetchMeta(String((payload && payload.url) || ''));
});

ipcMain.handle('authlib:login', async (_e, payload) => {
  const r = await core.authlib.login(String(payload.url), String(payload.username), String(payload.password));
  const domain = activeSiteDomain();
  const domainRoot = activeDomainRoot();
  if (domain && (!domainRoot || normalizeDomainRoot(r.root) !== domainRoot)) {
    throw new Error('当前处于「' + (domain.name || '站点域') + '」，只能登录该域对应的皮肤站' + (domainRoot ? '：' + domainRoot : ''));
  }
  let selected = r.selected;
  let accessToken = r.accessToken;
  if (!selected && r.profiles.length) {
    const pick = await core.authlib.selectProfile(r.root, accessToken, r.profiles[0].id);
    accessToken = pick.accessToken;
    selected = pick.selected;
  }
  settingsLib.setSecret('authlib', {
    root: r.root, serverName: r.serverName || '', accessToken, clientToken: r.clientToken,
    profiles: r.profiles, selected,
  });
  const alUid = core.accountstore.upsert({ uid: 'authlib-' + r.root + '-' + (selected ? selected.id : ''), type: 'authlib', name: selected ? selected.name : r.root, uuid: selected ? selected.id : '', payload: { root: r.root, serverName: r.serverName || '', accessToken, clientToken: r.clientToken, profiles: r.profiles, selected, skinUrl: (selected && selected.skinUrl) || '' } });
  if (selected) core.account.clearAvatarCache(selected.id, selected.name);
  core.accountstore.setActive(alUid);
  settingsLib.save({ loginMode: 'authlib' });
  log.info('皮肤站登录成功：' + (selected ? selected.name : '?') + ' @ ' + r.root);
  return { serverName: r.serverName, profiles: r.profiles, selected };
});

ipcMain.handle('accounts:selectProfile', async (_e, payload) => {
  const uid = String((payload && payload.uid) || '');
  const profileId = String((payload && payload.profileId) || '');
  const entry = core.accountstore.read().list.find((a) => a.uid === uid);
  if (!entry || entry.type !== 'authlib') throw new Error('该账户不是皮肤站账户');
  assertAccountAllowedInDomain(entry);
  const pl = entry.payload || {};
  if (!pl.root || !pl.accessToken) throw new Error('缺少皮肤站令牌，请重新登录');
  const r = await core.authlib.selectProfile(pl.root, pl.accessToken, profileId);
  const newPayload = { ...pl, accessToken: r.accessToken, selected: r.selected, skinUrl: (r.selected && r.selected.skinUrl) || pl.skinUrl || '' };
  if (r.selected) core.account.clearAvatarCache(r.selected.id, r.selected.name);
  core.accountstore.upsert({ uid, type: 'authlib', name: r.selected ? r.selected.name : entry.name, uuid: r.selected ? r.selected.id : entry.uuid, payload: newPayload });
  core.accountstore.setActive(uid);
  settingsLib.setSecret('authlib', {
    root: pl.root, serverName: pl.serverName || '', accessToken: r.accessToken,
    clientToken: pl.clientToken, profiles: pl.profiles, selected: r.selected,
  });
  settingsLib.save({ loginMode: 'authlib' });
  log.info('皮肤站角色已切换：' + (r.selected ? r.selected.name : '?'));
  return core.account.accountState();
});

ipcMain.handle('authlib:selectProfile', async (_e, payload) => {
  const al = settingsLib.getSecret('authlib');
  if (!al) throw new Error('尚未登录皮肤站');
  assertAccountAllowedInDomain({ type: 'authlib', payload: al });
  const r = await core.authlib.selectProfile(al.root, al.accessToken, String(payload.profileId));
  al.accessToken = r.accessToken;
  al.selected = r.selected;
  settingsLib.setSecret('authlib', al);
  return { selected: r.selected };
});

ipcMain.on('authlib:logout', () => {
  settingsLib.setSecret('authlib', null);
  if (settingsLib.all().loginMode === 'authlib') settingsLib.save({ loginMode: 'offline' });
  log.info('已退出皮肤站登录');
});

ipcMain.handle('memory:usage', () => core.memory.usage());

ipcMain.handle('memory:auto', () => core.memory.autoMemoryFromUsage());

ipcMain.handle('memory:free', async () => core.memory.freeWorkingSets());

ipcMain.handle('gpu:status', async () => {
  if (!core.gpu.supported()) return { supported: false, total: 0, high: 0 };
  const javas = await core.java.detect({ mcDirs: gameDirs().map((d) => d.path) });
  const prefs = await core.gpu.readAll();
  const rows = javas.map((j) => {
    const v = prefs.get(core.gpu.toJavaw(j.path).toLowerCase()) || '';
    return { path: j.path, high: v.includes('GpuPreference=2') };
  });
  return { supported: true, total: rows.length, high: rows.filter((r) => r.high).length };
});

ipcMain.handle('gpu:applyAll', async (_e, payload) => {
  const mode = String((payload && payload.mode) || 'auto');
  const javas = await core.java.detect({ mcDirs: gameDirs().map((d) => d.path) });
  const r = await core.gpu.applyAll(javas.map((j) => j.path), mode);
  settingsLib.save({ gpuHighPerf: mode === 'high' });
  return r;
});

// ---------- 启动器更新 ----------
ipcMain.handle('update:check', async (_e, opts = {}) => {
  const r = await core.updater.check(opts);
  if (r.available) send('update:available', r);
  return r;
});

ipcMain.handle('update:install', async (_e, payload) => {
  const asset = payload && payload.asset;
  if (!asset || !core.safe.isHttpUrl(asset.url, ['github.com', 'objects.githubusercontent.com'])) {
    throw new Error('更新地址无效');
  }
  requireIdle('update', '更新');
  busy.update = true;
  try {
    const r = await core.updater.install(asset, (p) => send('update:progress', p));
    setTimeout(() => app.exit(0), 1200);
    return r;
  } finally {
    busy.update = null;
  }
});

// ---------- 日志 ----------
ipcMain.handle('log:recent', () => log.recent(400));
ipcMain.on('log:clear', () => log.clear());
ipcMain.handle('game:openLog', async () => {
  // 游戏日志文件在实例目录 logs/ 下；打开最近运行的实例目录
  const dirs = gameDirs();
  if (dirs.length) shell.openPath(dirs[0].path);
  return true;
});
ipcMain.handle('game:copyCommand', (_e, payload) => {
  const id = core.safe.assertVersionId(String((payload && payload.id) || ''));
  const dir = String((payload && payload.dir) || settingsLib.all().mcDir);
  const built = core.launch.build(id, { sourceDir: dir });
  clipboard.writeText(built.command);
  return true;
});

log.info(`星启 SWUSTMCL ${app.getVersion()} 启动（GPU 兼容标记：${settingsLib.all().gpuFallback ? '开' : '关'}）`);
