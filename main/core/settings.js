'use strict';
/**
 * 配置持久化 + 加密密钥存储。
 *
 * - settings：明文 JSON（不含任何令牌），userData/swustmcl-config.json
 * - secrets：令牌等敏感数据用 Electron safeStorage（Windows 上走 DPAPI，
 *   绑定当前系统用户）加密后写入 userData/secrets.bin，读不到密文时静默作废。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, safeStorage } = require('electron');

const HOME = os.homedir();
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');

const BRAND_BLUE = '#1668dc'; // 校徽蓝（可被设置覆盖为跟随壁纸取色）

// 便携模式：默认游戏目录放在启动器同目录（与 PCL 一致，首次启动自动创建）
function portableMcDir() {
  try {
    const exeDir = path.dirname(app.getPath('exe'));
    if (exeDir && !/[\\/]node_modules[\\/]/.test(exeDir)) return path.join(exeDir, '.minecraft');
  } catch {}
  return path.join(APPDATA, '.minecraft');
}

const DEFAULTS = {
  mcDir: portableMcDir(),
  extraDirs: [],
  dirNames: {}, // 自定义启动器/目录显示名：{ 'D:\\PCL\\.minecraft': 'PCL' }
  javaPath: '',
  memory: 4096,
  autoMemory: false, // 自动分配内存（物理内存 35%，2048~8192）
  autoFreeMemory: true, // 启动游戏前自动优化内存（整理工作集）
  downloadSource: 'bmcl', // bmcl | mojang
  downloadThreads: 16,
  doh: false, // DoH（DNS over HTTPS）：域名被污染/解析异常时开启
  playerName: 'Steve',
  jvmArgs: '',
  fullscreen: false,
  resolution: { enabled: false, width: 925, height: 530 },
  autoCheck: true, // 每 5 分钟后台检查新正式版
  autoUpdateCheck: true, // 检查启动器自身更新
  gpuFallback: false, // GPU 进程崩溃后的兼容模式标记
  autoFixInjectors: true, // 自动结束搜狗等输入法的注入型附加组件（防启动闪退）
  isolateByDefault: false,
  autoDownloadJava: true, // 启动时缺对应版本 Java 自动下载运行时 // 版本隔离：所有实例的 gameDir 默认指向各自实例目录
  theme: 'dark', // dark | light
  accent: 'brand', // brand = 固定校徽蓝 | wallpaper = 跟随壁纸取色
  wallpaper: {
    enabled: true,
    image: '', // 空 = 出厂默认壁纸（随包内置） // wallpapers/ 下的文件名
    fit: 'cover', // cover 铺满 | contain 完整 | stretch 拉伸
    mask: 'soft', // none | soft | top | bottom | vignette
    opacity: 0.6,
    blur: 0,
    dim: 0.35,
    ui: 0.78, // 卡片/侧栏玻璃不透明度
  },
  saveGroup: 'folder', // folder | version | time
  cfApiKey: '',
  msClientId: '', // 可选：自注册 Azure 应用 ID；留空走免注册 Live 通道
  loginMode: 'offline', // offline | msa
  lastSeenVersion: '',
  gpuHighPerf: false,
};

let configPath = null;
let secretsPath = null;
let cache = null;

function init() {
  configPath = path.join(app.getPath('userData'), 'swustmcl-config.json');
  secretsPath = path.join(app.getPath('userData'), 'secrets.bin');
  cache = null;
  return load();
}

function load() {
  if (cache) return cache;
  let disk = {};
  try {
    if (configPath && fs.existsSync(configPath)) {
      disk = JSON.parse(fs.readFileSync(configPath, 'utf8')) || {};
    }
  } catch (e) {
    console.warn('[settings] 读取失败，使用默认值:', e.message);
    disk = {};
  }
  // 旧版默认并发是 8，静默升到 16（用户没主动改过的场景）
  if (disk.downloadThreads === 8) disk.downloadThreads = 16;
  cache = {
    ...DEFAULTS,
    ...disk,
    resolution: { ...DEFAULTS.resolution, ...(disk.resolution || {}) },
    wallpaper: { ...DEFAULTS.wallpaper, ...(disk.wallpaper || {}) },
  };
  return cache;
}

function all() {
  return load();
}

function save(patch = {}) {
  const next = { ...load(), ...patch };
  if (patch.resolution) next.resolution = { ...load().resolution, ...patch.resolution };
  if (patch.wallpaper) next.wallpaper = { ...load().wallpaper, ...patch.wallpaper };
  if (patch.extraDirs && !Array.isArray(patch.extraDirs)) next.extraDirs = load().extraDirs;
  cache = next;
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf8');
  } catch (e) {
    console.error('[settings] 写入失败:', e.message);
  }
  return next;
}

// ---------------------------------------------------------------- 加密存储
function readSecrets() {
  try {
    if (!secretsPath || !fs.existsSync(secretsPath) || !safeStorage) return {};
    const raw = fs.readFileSync(secretsPath);
    if (!safeStorage.isEncryptionAvailable()) return {};
    const json = safeStorage.decryptString(raw);
    return JSON.parse(json) || {};
  } catch {
    return {}; // 密文损坏 / 换了系统用户：静默作废，要求重新登录
  }
}

function writeSecrets(obj) {
  try {
    if (!secretsPath) return;
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      // 理论上 Windows 一定可用；不可用就不落盘，只留在内存
      return;
    }
    fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
    fs.writeFileSync(secretsPath, safeStorage.encryptString(JSON.stringify(obj)));
  } catch (e) {
    console.error('[settings] 密钥写入失败:', e.message);
  }
}

function getSecret(key) {
  return readSecrets()[key] || null;
}

function setSecret(key, value) {
  const all = readSecrets();
  if (value === null || value === undefined) delete all[key];
  else all[key] = value;
  writeSecrets(all);
}

/** 确保游戏目录结构存在，返回绝对路径 */
function ensureGameDir() {
  const dir = load().mcDir;
  for (const sub of ['', 'versions', 'libraries', 'assets']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

module.exports = { init, all, save, ensureGameDir, getSecret, setSecret, DEFAULTS, BRAND_BLUE };
