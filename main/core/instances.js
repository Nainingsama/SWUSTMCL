'use strict';
/**
 * 实例级管理：独立设置（Java/内存/JVM/显示名）、改名、Mod 管理。
 *
 * - 实例设置存 <实例目录>/swustmcl-instance.json（随实例走，拷目录即带设置）；
 * - 启动时在 launch.build 里合并：实例覆盖 > 全局；
 * - Mod 更新走 Modrinth「按文件 sha1 反查」接口，无需 project id。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const safe = require('./safe');
const net = require('./net');
const log = require('./log');

const MODRINTH = 'https://api.modrinth.com/v2';
const SETTINGS_FILE = 'swustmcl-instance.json';

// ------------------------------------------------------------ 实例设置
function settingsFile(instanceDir) {
  return path.join(instanceDir, SETTINGS_FILE);
}

function getSettings(instanceDir) {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(instanceDir), 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveSettings(instanceDir, patch = {}) {
  const out = { ...getSettings(instanceDir) };
  for (const [k, v] of Object.entries(patch)) {
    switch (k) {
      case 'displayName': {
        const s = String(v || '').trim();
        if (s.length > 48) throw new Error('显示名过长（≤48 字符）');
        out.displayName = s || '';
        break;
      }
      case 'javaPath': {
        const p = String(v || '').trim();
        if (p && !/javaw?(\.exe)?$/i.test(path.basename(p))) throw new Error('Java 路径必须是 java.exe / javaw.exe');
        if (p && !fs.existsSync(p)) throw new Error('Java 路径不存在');
        out.javaPath = p;
        break;
      }
      case 'memory': {
        if (v === null || v === '' || v === undefined) { out.memory = 0; break; }
        const n = Number(v);
        if (!Number.isFinite(n) || n < 512 || n > 32768) throw new Error('内存无效（512~32768 MB）');
        out.memory = Math.round(n);
        break;
      }
      case 'isolate': {
        // true=隔离 / false=共享 / 'auto'=跟随全局
        out.isolate = v === 'auto' ? 'auto' : Boolean(v);
        break;
      }
      case 'jvmArgs': {
        const s = String(v || '');
        if (s.length > 2000) throw new Error('JVM 参数过长');
        if (/-javaagent:|-agentlib:/i.test(s)) throw new Error('JVM 参数包含不允许的代理注入');
        out.jvmArgs = s;
        break;
      }
      default:
        throw new Error(`不支持的实例设置项: ${k}`);
    }
  }
  fs.writeFileSync(settingsFile(instanceDir), JSON.stringify(out, null, 2), 'utf8');
  return out;
}

/** 启动合并：实例设置覆盖全局 */
function mergedLaunchOptions(instanceDir, globalOpts) {
  const s = getSettings(instanceDir);
  const merged = { ...globalOpts };
  if (s.javaPath) merged.javaPath = s.javaPath;
  if (s.memory) merged.memory = s.memory;
  if (s.jvmArgs) merged.jvmArgs = s.jvmArgs;
  merged.displayName = s.displayName || '';
  merged.isolate = s.isolate === undefined ? 'auto' : s.isolate;
  return merged;
}

/** 改实例名：目录整体移动 + json/jar 同步改名 + json.id 更新 */
async function renameInstance(mcDir, oldId, newId) {
  safe.assertVersionId(oldId, '原实例名');
  safe.assertVersionId(newId, '新实例名');
  if (oldId === newId) return { id: newId };
  const oldDir = safe.safeJoin(path.join(mcDir, 'versions'), oldId);
  const newDir = safe.safeJoin(path.join(mcDir, 'versions'), newId);
  if (!fs.existsSync(oldDir)) throw new Error('原实例不存在');
  if (fs.existsSync(newDir)) throw new Error('已存在同名实例');
  await fsp.rename(oldDir, newDir);
  // json / jar / natives 目录改名
  for (const ext of ['.json', '.jar']) {
    const from = path.join(newDir, oldId + ext);
    const to = path.join(newDir, newId + ext);
    if (fs.existsSync(from)) await fsp.rename(from, to).catch(() => {});
  }
  const nativesOld = path.join(newDir, 'natives');
  if (fs.existsSync(nativesOld)) { /* natives 是平铺目录，不需要改名 */ }
  // json 内容里的 id 字段
  const jsonPath = path.join(newDir, `${newId}.json`);
  try {
    const json = JSON.parse(await fsp.readFile(jsonPath, 'utf8'));
    json.id = newId;
    await fsp.writeFile(jsonPath, JSON.stringify(json, null, 2), 'utf8');
  } catch {}
  log.info(`实例已改名：${oldId} → ${newId}`);
  return { id: newId };
}

// ------------------------------------------------------------ Mod 管理
/**
 * 列出 mods 目录，并从 jar 内读取 mod 元数据（fabric.mod.json / mods.toml）。
 * @returns 数组：{file,name,fileName,enabled,size,mtime, modName, version, authors, icon(dataUrl|null), description}
 */
async function listMods(instanceDir) {
  const modsDir = path.join(instanceDir, 'mods');
  const out = [];
  let ents = [];
  try {
    ents = await fsp.readdir(modsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  const files = [];
  for (const e of ents) {
    if (!e.isFile()) continue;
    if (!/\.(jar|disabled)$/i.test(e.name)) continue;
    const full = path.join(modsDir, e.name);
    try {
      const st = await fsp.stat(full);
      files.push({ file: full, name: e.name.replace(/\.disabled$/i, ''), fileName: e.name, enabled: !/\.disabled$/i.test(e.name), size: st.size, mtime: st.mtimeMs });
    } catch {}
  }

  // 元数据解析（受控并发，几十个 jar 也在 1 秒内）
  let cursor = 0;
  const workers = new Array(Math.min(4, files.length)).fill(0).map(async () => {
    for (;;) {
      const item = files[cursor++];
      if (!item) return;
      const meta = readJarMeta(item.file).catch(() => null);
      const r = await meta;
      Object.assign(item, r || {});
      out.push(item);
    }
  });
  await Promise.all(workers);
  out.sort((a, b) => (a.modName || a.name).localeCompare(b.modName || b.name));
  return out;
}

/** 从 jar 读 mod 元数据（fabric.mod.json 优先，其次 mods.toml / mcmod.info） */
async function readJarMeta(jarFile) {
  let zip;
  try {
    zip = new AdmZip(jarFile);
  } catch {
    return null;
  }
  const readEntry = (name) => {
    const e = zip.getEntry(name);
    return e ? zip.readAsText(e) : null;
  };

  // ---- fabric.mod.json ----
  const fabricRaw = readEntry('fabric.mod.json');
  if (fabricRaw) {
    try {
      const j = JSON.parse(fabricRaw);
      return {
        modName: j.name || '',
        version: j.version || '',
        authors: Array.isArray(j.authors) ? j.authors.map((a) => (typeof a === 'string' ? a : a.name)).filter(Boolean).join(', ') : '',
        description: j.description || '',
        icon: await iconDataUrl(zip, j.icon),
      };
    } catch {}
  }

  // ---- mods.toml（Forge/NeoForge 1.13+）----
  const tomlRaw = readEntry('META-INF/mods.toml') || readEntry('META-INF/neoforge.mods.toml');
  if (tomlRaw) {
    const parsed = parseTomlMods(tomlRaw);
    if (parsed) return { ...parsed, icon: await iconDataUrl(zip, parsed.iconPath) };
  }

  // ---- mcmod.info（旧版 Forge）----
  const infoRaw = readEntry('mcmod.info');
  if (infoRaw) {
    try {
      const j = JSON.parse(infoRaw);
      const first = Array.isArray(j) ? j[0] : (j.modList || [])[0];
      if (first) {
        return {
          modName: first.name || '',
          version: first.version || '',
          authors: (first.authorList || []).join(', '),
          description: first.description || '',
          icon: null,
        };
      }
    } catch {}
  }
  return null;
}

/** 极简 TOML 提取：只要 [[mods]] 段的 modId/name/version/authors/icon/displayTest 附近字段 */
function parseTomlMods(raw) {
  try {
    // 取 [[mods]] 到下一个 [[ 段之间
    const m = raw.match(/\[\[mods\]\]([\s\S]*?)(\n\[\[|$)/i);
    if (!m) return null;
    const body = m[1];
    const pick = (key) => {
      const r = body.match(new RegExp(`^\\s*${key}\\s*=\\s*['"]([^'"]*)['"]`, 'm'));
      return r ? r[1] : '';
    };
    const authorsR = body.match(/^\s*authors\s*=\s*\[([^\]]*)\]/m);
    const authors = authorsR
      ? authorsR[1].split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).join(', ')
      : pick('authors');
    return {
      modName: pick('displayName') || pick('modId'),
      version: pick('version') === '${file.jarVersion}' ? '' : pick('version'),
      authors,
      description: pick('description'),
      iconPath: pick('logoFile'),
    };
  } catch {
    return null;
  }
}

/** 从 jar 提取图标文件转 dataUrl（限制大小） */
async function iconDataUrl(zip, iconPath) {
  if (!iconPath) return null;
  try {
    const e = zip.getEntry(String(iconPath).replace(/\\/g, '/'));
    if (!e || e.isDirectory) return null;
    if (e.header.size > 256 * 1024) return null;
    const buf = e.getData();
    if (buf.length < 8 || buf[0] !== 0x89) return null; // 只收 PNG
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

async function setModEnabled(file, enabled) {
  safe.assertWithin(path.dirname(file), file, 'Mod 文件');
  const cur = file;
  const target = enabled ? file.replace(/\.disabled$/i, '') : file.replace(/\.jar$/i, '') + '.disabled';
  if (fs.existsSync(cur)) await fsp.rename(cur, target);
  return { file: target, enabled };
}

async function deleteMod(file) {
  const { shell } = require('electron');
  safe.assertWithin(path.dirname(file), file, 'Mod 文件');
  const moved = await shell.trashItem(file);
  if (!moved) throw new Error('移入回收站失败——文件可能被占用');
  return { ok: true };
}

// ------------------------------------------------------------ Mod 更新（Modrinth 按 sha1 反查）
function sha1Of(file) {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
}

/**
 * 查询单个 mod 的可用更新。
 * @returns {{known:boolean, current?:object, latest?:{versionNumber:string, url:string, filename:string, date:string}}}
 */
async function checkModUpdate(file, gameVersion) {
  const sha1 = sha1Of(file);
  // 1) 按 sha1 反查当前版本
  const cur = await net.fetchJson(`${MODRINTH}/version_file/${sha1}?algorithm=sha1`, { timeout: 15000 }).catch(() => null);
  if (!cur || !cur.project_id) return { known: false };
  // 2) 查该项目的最新适配版本
  const gv = gameVersion ? encodeURIComponent(JSON.stringify([gameVersion])) : '';
  const loaders = ''; // 不按 loader 过滤，容忍边缘打包差异
  const versions = await net.fetchJson(`${MODRINTH}/project/${cur.project_id}/version${gv ? `?game_versions=${gv}` : ''}`, { timeout: 15000 }).catch(() => []);
  const list = Array.isArray(versions) ? versions : [];
  const latest = list[0];
  if (!latest) return { known: true, current: { versionNumber: cur.version_number }, latest: null };
  const file2 = (latest.files || []).find((f) => f.primary) || (latest.files || [])[0];
  const newer = latest.date_published && cur.date_published
    ? new Date(latest.date_published) > new Date(cur.date_published)
    : latest.id !== cur.id;
  return {
    known: true,
    current: { versionNumber: cur.version_number, date: cur.date_published },
    latest: newer && file2
      ? {
          versionNumber: latest.version_number,
          url: file2.url,
          filename: file2.filename,
          size: file2.size || 0,
          date: latest.date_published,
        }
      : null,
  };
}

/** 下载新版本到 mods/ 并把旧文件禁用 */
async function applyModUpdate(file, url, filename) {
  const modsDir = path.dirname(file);
  const dest = safe.safeJoin(modsDir, safe.safeEntryName(filename) || ('update-' + Date.now() + '.jar'));
  await net.download(url, dest, {
    expectZip: /\.jar$/i.test(dest),
    retries: 2,
    onBytes: null,
  });
  // 旧文件禁用
  if (/\.jar$/i.test(file)) {
    await fsp.rename(file, file.replace(/\.jar$/i, '') + '.disabled').catch(() => {});
  }
  log.info(`Mod 已更新：${path.basename(file)} → ${path.basename(dest)}`);
  return { file: dest, filename: path.basename(dest) };
}

module.exports = {
  getSettings, saveSettings, mergedLaunchOptions, renameInstance,
  listMods, setModEnabled, deleteMod, checkModUpdate, applyModUpdate,
};
