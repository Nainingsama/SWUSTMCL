'use strict';
/**
 * 版本元数据：远端清单（双源竞速）、本地已安装扫描、版本 JSON 读取与继承合并。
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { fetchJson } = require('./net');
const mirror = require('./mirror');
const safe = require('./safe');
const dirsLib = require('./dirs');

let manifestCache = { time: 0, data: null };
const TTL = 10 * 60 * 1000;

function manifestCachePath() {
  return path.join(app.getPath('userData'), 'version_manifest_cache.json');
}

function readDiskCache() {
  try {
    const p = manifestCachePath();
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeDiskCache(payload) {
  try {
    fs.writeFileSync(manifestCachePath(), JSON.stringify(payload), 'utf8');
  } catch {}
}

/**
 * 双源竞速拉取清单：Promise.any 同时请求 BMCLAPI 与官方源，谁先成功用谁。
 * 两边都失败时退回磁盘缓存（断网仍能展示上次的列表）。
 * @param {{force?:boolean}} opts
 */
async function getManifest(opts = {}) {
  const now = Date.now();
  if (!opts.force && manifestCache.data && now - manifestCache.time < TTL) {
    return manifestCache.data;
  }

  const disk = readDiskCache();
  if (!opts.force && disk && disk.data && now - disk.time < 6 * 60 * 60 * 1000) {
    // 磁盘缓存兜底仅当在线拉取失败时使用；这里先试着刷新
  }

  try {
    const tasks = [
      fetchJson(mirror.MANIFEST.bmcl, { retries: 0, timeout: 9000 }),
      fetchJson(mirror.MANIFEST.mojang, { retries: 0, timeout: 9000 }),
    ];
    const data = await Promise.any(tasks);
    if (!data || !Array.isArray(data.versions)) throw new Error('返回结构异常');
    data.__source = 'race';
    manifestCache = { time: now, data };
    writeDiskCache({ time: now, data });
    return data;
  } catch (e) {
    if (disk && disk.data) {
      manifestCache = { time: disk.time, data: disk.data };
      disk.data.__source = 'cache';
      return disk.data;
    }
    throw new Error(`版本清单获取失败（双源均不可达）— ${e.message}`);
  }
}

/** 取单个版本的元数据（含下载地址） */
async function getVersionMeta(entry, source) {
  if (entry && entry.json && entry.json.libraries) return entry.json;
  // 单文件走主源 + 失败换源
  const url = mirror.rewrite(entry.url, source);
  let json;
  try {
    json = await fetchJson(url, { timeout: 30000, retries: 1 });
  } catch {
    const alt = source === 'bmcl' ? 'mojang' : 'bmcl';
    json = await fetchJson(mirror.rewrite(entry.url, alt), { timeout: 30000, retries: 1 });
  }
  entry.json = json;
  return json;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 判断加载器类型（用于 UI 标签） */
function loaderOf(id = '', mainClass = '') {
  const s = `${id} ${mainClass}`.toLowerCase();
  // neoforge 必须在 forge 之前判断。注意：Forge 1.17+ 的 mainClass 也是
  // cpw.mods.bootstraplauncher.BootstrapLauncher，不能单凭 bootstraplauncher 判 NeoForge
  if (s.includes('neoforge') || s.includes('neoforged')) return 'NeoForge';
  // Forge 1.17+ 的 mainClass 是 cpw.mods.bootstraplauncher.BootstrapLauncher（不含 neoforged 才是 Forge）
  if (s.includes('bootstraplauncher')) return 'Forge';
  if (s.includes('fabric')) return 'Fabric';
  if (s.includes('quilt')) return 'Quilt';
  if (s.includes('optifine')) return 'OptiFine';
  if (s.includes('liteloader')) return 'LiteLoader';
  if (s.includes('forge') || s.includes('launchwrapper') || s.includes('fml')) return 'Forge';
  return '原版';
}

function countEntries(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => !n.endsWith('.disabled')).length;
  } catch {
    return 0;
  }
}

/**
 * 推断实例对应的原版版本。优先级：
 * --fml.mcVersion → 加载器主库坐标 → 实例名里的版本号（Fabric 靠这个）
 */
function guessMcVersion(id, json) {
  const args = (json && json.arguments && json.arguments.game) || [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--fml.mcVersion' && typeof args[i + 1] === 'string' && /^[\d.]{2,10}$/.test(args[i + 1])) {
      return args[i + 1];
    }
  }
  const names = ((json && json.libraries) || []).map((l) => String((l && l.name) || ''));
  for (const n of names) {
    const neo = n.match(/^net\.neoforged:neoforge:([\d.]+)/);
    if (neo) {
      const [a, b] = neo[1].split('.');
      if (a && b) return Number(a) >= 26 ? `${a}.${b}` : `1.${a}.${b}`;
    }
    const forge = n.match(/^net\.minecraftforge:forge:(1\.[\d.]+)-/);
    if (forge) return forge[1];
  }
  // fabric-loader-0.20.1-26.3 / quilt-loader-x-y-z-1.21.4：MC 版本在加载器版本之后
  const fl = String(id || '').match(/^(?:fabric|quilt)-loader-[\d.]+-(.+)$/);
  if (fl) {
    const mcPart = fl[1].match(/^(\d{1,2}\.\d{1,2}(?:\.\d{1,2})?)/);
    if (mcPart) return mcPart[1];
  }
  // 经典命名：1.21.10 / fabric-loader-0.16.9-1.21.1
  const m = String(id || '').match(/\b(1\.\d{1,2}(?:\.\d{1,2})?)\b/);
  if (m) return m[1];
  // 新时代命名：MC 26 起不再以 1. 开头（26.3 / 26.1.2）
  const m2 = String(id || '').match(/\b((?:2[6-9]|[3-9]\d)\.\d{1,2}(?:\.\d{1,2})?)\b/);
  if (m2) return m2[1];
  // 纯版本号目录名的原版实例（如 26.3）：json.id 即 MC 版本
  const m3 = String((json && json.id) || '').match(/^(\d{1,2}\.\d{1,2}(?:\.\d{1,2})?)$/);
  return m3 ? m3[1] : '';
}

/** PCL 版本隔离实例：PCL/Setup.ini 里有权威的原版版本字段（VersionVanillaName/VersionVanilla） */
function pclMcVersion(instDir) {
  try {
    const ini = fs.readFileSync(path.join(instDir, 'PCL', 'Setup.ini'), 'utf8');
    const name = (ini.match(/^VersionVanillaName:(.+)$/m) || [])[1];
    const raw = (name && name.trim()) || ((ini.match(/^VersionVanilla:([\d.]+)$/m) || [])[1] || '');
    const mm = String(raw).match(/^(\d{1,2}\.\d{1,2}(?:\.\d{1,2})?)/);
    if (!mm) return '';
    return mm[1].replace(/\.0$/, ''); // 26.3.0 → 26.3
  } catch {
    return '';
  }
}

/**
 * 扫描多个游戏目录下的实例（跨目录汇总）
 * @param {Array<{path:string,name:string,kind:string}>} gameDirs
 */
function listInstalled(gameDirs) {
  const dirs = Array.isArray(gameDirs) ? gameDirs : [{ path: gameDirs, name: '主目录', kind: 'primary' }];
  const out = [];
  const seen = new Set();

  for (const d of dirs) {
    const root = path.join(d.path, 'versions');
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const id = ent.name;
      const instDir = path.join(root, id);
      const jsonPath = path.join(instDir, `${id}.json`);
      if (!fs.existsSync(jsonPath)) continue;
      const json = readJson(jsonPath);
      if (!json) continue;

      const key = `${d.path}|${id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      let updatedAt = Date.now();
      try {
        updatedAt = fs.statSync(jsonPath).mtimeMs;
      } catch {}

      out.push({
        id,
        dir: d.path,
        dirName: d.name,
        kind: d.kind,
        type: json.type || 'release',
        mainClass: json.mainClass || '',
        javaMajor: (json.javaVersion && json.javaVersion.majorVersion) || 8,
        mcVersion: guessMcVersion(id, json) || guessMcVersion(json.inheritsFrom, null) || pclMcVersion(instDir),
        inheritsFrom: json.inheritsFrom || '',
        loader: loaderOf(id, json.mainClass),
        hasJar: fs.existsSync(path.join(instDir, `${id}.jar`)),
        isolated: dirsLib.isIsolatedInstance(instDir),
        displayName: (() => { try { return JSON.parse(fs.readFileSync(path.join(instDir, 'swustmcl-instance.json'), 'utf8')).displayName || ''; } catch { return ''; } })(),
        mods: countEntries(path.join(instDir, 'mods')),
        size: null, // 体积由后台异步补齐
        updatedAt,
      });
    }
  }

  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/**
 * 异步统计目录体积。
 * 关键：必须用 fs.promises 并逐项 await 让出事件循环 —— 同步递归遍历
 * 几万文件会把主进程堵死几十秒，期间所有 IPC（下拉/点击/列表）全部无响应。
 */
async function dirSize(dir, depth = 0) {
  if (depth > 4) return 0;
  let total = 0;
  let ents = [];
  try {
    ents = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += await dirSize(full, depth + 1);
      else total += (await fs.promises.stat(full)).size;
    } catch {}
  }
  return total;
}

/** 读取本地版本 JSON，沿 inheritsFrom 链合并 */
function loadVersionJson(mcDir, id, depth = 0) {
  if (depth > 5) throw new Error('版本继承层级过深');
  safe.assertVersionId(id);
  const file = safe.safeJoin(path.join(mcDir, 'versions'), id, `${id}.json`);
  const json = readJson(file);
  if (!json) throw new Error(`未找到版本 ${id} 的 JSON（${path.join(mcDir, 'versions', id)}），可能尚未安装或目录不正确`);
  if (!json.inheritsFrom) return { ...json, id };
  const parent = loadVersionJson(mcDir, json.inheritsFrom, depth + 1);
  return mergeVersion(parent, { ...json, id });
}

/**
 * Maven 坐标匹配键 group:artifact[:classifier]——不比版本号，子版本优先。
 * 缺了这层去重，三层继承会把同一个 jar 塞进 classpath 两次，
 * Forge 的 BootstrapLauncher 直接抛 Duplicate key。
 */
function libraryKey(lib) {
  const name = String((lib && lib.name) || '');
  const parts = name.split(':');
  if (parts.length < 2) return name;
  const classifier = parts[3] || '';
  return `${parts[0]}:${parts[1]}${classifier ? ':' + classifier : ''}`;
}

function mergeLibraries(parent = [], child = []) {
  const order = new Map();
  let seq = 0;
  for (const lib of parent) {
    const k = libraryKey(lib);
    if (!order.has(k)) order.set(k, { lib, seq: seq++ });
  }
  for (const lib of child) {
    const k = libraryKey(lib);
    const prev = order.get(k);
    order.set(k, { lib, seq: prev ? prev.seq : seq++ });
  }
  return [...order.values()].sort((a, b) => a.seq - b.seq).map((x) => x.lib);
}

function mergeVersion(parent, child) {
  const merged = { ...parent, ...child };
  merged.id = child.id;
  merged.inheritsFrom = child.inheritsFrom;
  merged.libraries = mergeLibraries(parent.libraries, child.libraries);
  merged.assetIndex = child.assetIndex || parent.assetIndex;
  merged.assets = child.assets || parent.assets;
  merged.downloads = { ...(parent.downloads || {}), ...(child.downloads || {}) };
  merged.mainClass = child.mainClass || parent.mainClass;
  if (child.arguments) {
    merged.arguments = {
      game: [...((parent.arguments && parent.arguments.game) || []), ...(child.arguments.game || [])],
      jvm: [...((parent.arguments && parent.arguments.jvm) || []), ...(child.arguments.jvm || [])],
    };
  }
  return merged;
}

module.exports = { getManifest, guessMcVersion, pclMcVersion, getVersionMeta, listInstalled, loadVersionJson, readJson, loaderOf, dirSize };
