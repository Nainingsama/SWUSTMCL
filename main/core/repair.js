'use strict';
/**
 * 依赖修复：按版本 JSON（含继承链）核对 client.jar / libraries / natives，
 * 列出缺失与损坏文件并补齐。重复调用是安全的（增量逻辑在 net.download 里）。
 */
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const net = require('./net');
const mirror = require('./mirror');
const versionLib = require('./versions');
const rules = require('./rules');
const safe = require('./safe');
const { isZipFile } = require('./net');

const osName = rules.OS_NAME;

function collectExpected(mcDir, id) {
  const meta = versionLib.loadVersionJson(mcDir, id);
  const out = [];

  if (meta.downloads && meta.downloads.client && meta.downloads.client.url) {
    const c = meta.downloads.client;
    out.push({
      url: c.url,
      dest: path.join(mcDir, 'versions', id, `${id}.jar`),
      size: c.size || 0,
      sha1: c.sha1 || '',
      expectZip: true,
      name: `${id}.jar`,
    });
  }

  const libRoot = path.join(mcDir, 'libraries');
  for (const lib of meta.libraries || []) {
    if (!rules.allowed(lib.rules, {})) continue;
    const name = String(lib.name || '');
    if (!/^[\w.-]+:[\w.-]+:[^:]+/.test(name)) continue;
    const art = lib.downloads && lib.downloads.artifact;
    const rel = (art && art.path) || install_mavenPath(name);
    // Fabric/Quilt 的元数据只有 Maven 坐标 + 仓库 url（没有 downloads.artifact），
    // 漏掉它们会导致缺库检不出来、启动报 ClassNotFoundException
    let url = art && art.url;
    if (!url) {
      const base = String(lib.url || 'https://libraries.minecraft.net/').replace(/\/+$/, '');
      url = `${base}/${rel}`;
    }
    let libDest;
    try {
      libDest = safe.safeJoin(libRoot, rel);
    } catch {
      continue; // 元数据里的路径非法，跳过
    }
    out.push({
      url,
      dest: libDest,
      size: (art && art.size) || 0,
      sha1: (art && art.sha1) || lib.sha1 || '',
      expectZip: true,
      name,
    });
  }

  const logFile = meta.logging && meta.logging.client && meta.logging.client.file;
  if (logFile && logFile.url) {
    const candidate = String(logFile.id || 'client.xml');
    if (safe.safeEntryName(candidate) !== candidate) {
      // 文件名非法则跳过，不参与修复
    } else {
      out.push({
        url: logFile.url,
        dest: safe.safeJoin(path.join(mcDir, 'assets', 'log_configs'), candidate),
        size: logFile.size || 0,
        sha1: logFile.sha1 || '',
        expectZip: false,
        name: 'log4j config',
      });
    }
  }

  return { meta, files: out };
}

// 避免与 repair 循环依赖：内联一份 mavenPath
function install_mavenPath(name) {
  const parts = String(name).split(':');
  const [group, artifact, version, classifier] = parts;
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`;
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`;
}

/**
 * 体检：client.jar 是否存在且真的是 zip（jar 损坏检测），库文件是否缺失。
 * @returns {{ok:boolean, missing:Array, brokenJar:boolean, meta:object}}
 */
function check(mcDir, id) {
  const missing = [];
  let brokenJar = false;
  let meta = null;
  try {
    const { meta: m, files } = collectExpected(mcDir, id);
    meta = m;
    for (const f of files) {
      let st;
      try {
        st = fs.statSync(f.dest);
      } catch {
        missing.push(f);
        continue;
      }
      if (f.size && st.size !== f.size) {
        // 大小不符：有 sha1 的等修复时再核哈希，无 sha1 的直接标记
        missing.push(f);
        continue;
      }
      if (f.expectZip && st.size > 0 && !isZipFile(f.dest)) {
        brokenJar = true;
        missing.push(f);
      }
    }
  } catch {
    // 版本 JSON 都读不到，交给上层报错
  }
  return { ok: missing.length === 0, missing, brokenJar, meta };
}

/** 读取模组 jar 的 fabric.mod.json，判断是否依赖 Fabric API 提供的模块 */
function jarNeedsFabricApi(file) {
  try {
    const zip = new AdmZip(file);
    const txt = zip.readAsText('fabric.mod.json');
    if (!txt) return false;
    const meta = JSON.parse(txt);
    const deps = meta && meta.depends && typeof meta.depends === 'object' ? meta.depends : {};
    const standalone = new Set(['fabric', 'fabric-loader', 'fabric-language-kotlin', 'fabric-permissions-api', 'fabric-placeholder-api']);
    return Object.keys(deps).some((k) => k === 'fabric-api' || ((k.startsWith('fabric-') || k === 'fabric-resource-loader-v0') && !standalone.has(k)));
  } catch {
    return false;
  }
}

/**
 * 模组前置检查：Fabric 实例装了模组却没有 Fabric API 时，很多整合包会直接
 * 报「fabric-api / fabric-resource-loader-v0 未安装」。返回需要补的模组。
 */
function modCheck(mcDir, id) {
  try {
    const meta = versionLib.loadVersionJson(mcDir, id);
    const loader = versionLib.loaderOf(id, meta);
    if (loader !== 'Fabric') return { missing: [] };
    const modsDir = path.join(mcDir, 'versions', id, 'mods');
    let jars = [];
    try { jars = fs.readdirSync(modsDir).filter((f) => /\.jar$/i.test(f)); } catch {}
    if (!jars.length) return { missing: [] };
    if (jars.some((f) => /^fabric[-_]api(?:[-_.]|$)/i.test(f))) return { missing: [] };
    // 只有确实有模组声明依赖 Fabric API 时才补，避免给普通 Fabric 实例多装前置
    if (!jars.some((f) => jarNeedsFabricApi(path.join(modsDir, f)))) return { missing: [] };
    const mc = versionLib.guessMcVersion(id, meta) || versionLib.guessMcVersion(meta.inheritsFrom, null) || (() => {
      // 合并导入实例的版本号保存在 swustmcl-instance.json 的 mergedFrom（如 1.21.1）
      try { return JSON.parse(fs.readFileSync(path.join(mcDir, 'versions', id, 'swustmcl-instance.json'), 'utf8')).mergedFrom || ''; } catch { return ''; }
    })();
    return { missing: [{ name: 'fabric-api', kind: 'mod', mcVersion: mc }] };
  } catch {
    return { missing: [] };
  }
}

/** 从 Modrinth 下载与实例游戏版本匹配的 Fabric API */
async function ensureFabricApi(mcDir, id, onProgress, signal) {
  const abortIf = () => { if (signal && signal.aborted) { const e = new Error('已取消'); e.aborted = true; throw e; } };
  const check = modCheck(mcDir, id);
  if (!check.missing.length) return { added: 0, remaining: [] };
  const mc = check.missing[0].mcVersion;
  if (!mc) return { added: 0, remaining: [{ name: 'fabric-api', error: '无法确定游戏版本' }] };
  const qs = 'loaders=' + encodeURIComponent('["fabric"]') + '&game_versions=' + encodeURIComponent(JSON.stringify([mc]));
  const apis = [
    'https://api.modrinth.com/v2/project/fabric-api/version?' + qs,
    'https://mod.mcimirror.top/modrinth/v2/project/fabric-api/version?' + qs,
  ];
  let list = null;
  for (const url of apis) {
    try {
      const r = await net.fetchJson(url, { timeout: 8000, retries: 0 });
      if (Array.isArray(r) && r.length) { list = r; break; }
    } catch (e) {
      if (e && e.aborted) throw e;
    }
  }
  if (!list) return { added: 0, remaining: [{ name: 'fabric-api', error: '查询失败（Modrinth / MCIM 均不可用）' }] };
  list = list.slice().sort((a, b) => String(b.date_published || '').localeCompare(String(a.date_published || '')));
  const pick = list.find((v) => v.version_type === 'release') || list[0];
  const file = (pick.files || []).find((f) => f.primary) || (pick.files || [])[0];
  if (!file || !file.url) return { added: 0, remaining: [{ name: 'fabric-api', error: '下载地址为空' }] };
  const ver = String(pick.version_number || '');
  const maven = ver
    ? 'https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/' + encodeURIComponent(ver) + '/fabric-api-' + encodeURIComponent(ver) + '.jar'
    : '';
  const urls = [...new Set([maven, file.url].filter(Boolean))];
  const dest = path.join(mcDir, 'versions', id, 'mods', file.filename || 'fabric-api.jar');
  const total = Number(file.size) || 0;
  let received = 0;
  const reportBytes = (n) => {
    received += Number(n) || 0;
    if (!onProgress) return;
    const pct = total ? Math.min(99, Math.round((received / total) * 100)) : 0;
    const msg = total ? `正在补齐 Fabric API… ${pct}%` : `正在补齐 Fabric API… ${(received / 1048576).toFixed(1)} MB`;
    onProgress({ done: received, total: total || 0, bytes: true, message: msg });
  };
  let lastErr = null;
  for (const url of urls) {
    try {
      abortIf();
      await net.download(url, dest, {
        expectedSize: total,
        expectedSha1: (file.hashes && file.hashes.sha1) || '',
        expectZip: true,
        retries: 1,
        onBytes: reportBytes,
        signal,
      });
      if (onProgress) onProgress({ done: total || 1, total: total || 1, message: 'Fabric API 已补齐' });
      return { added: 1, remaining: [] };
    } catch (e) {
      if (e && e.aborted) throw e;
      lastErr = e;
    }
  }
  return { added: 0, remaining: [{ name: 'fabric-api', error: lastErr ? lastErr.message : '下载失败' }] };
}

/**
 * 修复缺失依赖。jar 头损坏的文件先删再补。
 * @param {(p:{done:number,total:number})=>void} [onProgress]
 */
async function fix(mcDir, id, onProgress, source, opts = {}) {
  const signal = opts.signal || null;
  const abortIf = () => { if (signal && signal.aborted) { const e = new Error('已取消'); e.aborted = true; throw e; } };
  const { files } = collectExpected(mcDir, id);
  const tasks = files.filter((f) => {
    let st;
    try {
      st = fs.statSync(f.dest);
    } catch {
      return true;
    }
    if (f.expectZip && st.size > 0 && !isZipFile(f.dest)) {
      try { fs.unlinkSync(f.dest); } catch {}
      return true;
    }
    if (f.size && st.size !== f.size) return true;
    return false;
  });

  const remaining = [];
  let done = 0;
  const src = source || 'bmcl';
  await net.pool(tasks, 12, async (t) => {
    abortIf();
    const alt = src === 'bmcl' ? 'mojang' : 'bmcl';
    try {
      await net.download(mirror.rewrite(t.url, src), t.dest, { expectedSize: t.size, expectedSha1: t.sha1 || '', expectZip: t.expectZip, retries: 1, signal });
    } catch {
      try {
        await net.download(mirror.rewrite(t.url, alt), t.dest, { expectedSize: t.size, expectedSha1: t.sha1 || '', expectZip: t.expectZip, retries: 1, signal });
      } catch (e2) {
        if (e2 && e2.aborted) throw e2;
        remaining.push({ name: t.name, error: e2.message });
      }
    }
    done += 1;
    if (onProgress) onProgress({ done, total: tasks.length });
  });

  let added = 0;
  try {
    const api = await ensureFabricApi(mcDir, id, onProgress, signal);
    added = api.added || 0;
    if (api.remaining && api.remaining.length) remaining.push(...api.remaining);
  } catch (e) {
    if (e && e.aborted) throw e;
    remaining.push({ name: 'fabric-api', error: e.message });
  }
  return { fixed: tasks.length - remaining.length + added, remaining };
}

module.exports = { check, fix, modCheck, ensureFabricApi };
