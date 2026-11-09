'use strict';
/**
 * 依赖修复：按版本 JSON（含继承链）核对 client.jar / libraries / natives，
 * 列出缺失与损坏文件并补齐。重复调用是安全的（增量逻辑在 net.download 里）。
 */
const fs = require('fs');
const path = require('path');

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

/**
 * 修复缺失依赖。jar 头损坏的文件先删再补。
 * @param {(p:{done:number,total:number})=>void} [onProgress]
 */
async function fix(mcDir, id, onProgress, source) {
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
  await net.pool(tasks, 6, async (t) => {
    const alt = src === 'bmcl' ? 'mojang' : 'bmcl';
    try {
      await net.download(mirror.rewrite(t.url, src), t.dest, { expectedSize: t.size, expectedSha1: t.sha1 || '', expectZip: t.expectZip, retries: 1 });
    } catch {
      try {
        await net.download(mirror.rewrite(t.url, alt), t.dest, { expectedSize: t.size, expectedSha1: t.sha1 || '', expectZip: t.expectZip, retries: 1 });
      } catch (e2) {
        remaining.push({ name: t.name, error: e2.message });
      }
    }
    done += 1;
    if (onProgress) onProgress({ done, total: tasks.length });
  });

  return { fixed: tasks.length - remaining.length, remaining };
}

module.exports = { check, fix };
