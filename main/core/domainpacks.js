'use strict';
/**
 * 站点型域整合包：扫描隔离实例、清单差异、分片上传、安装/更新。
 *
 * 站点只保存按 SHA-256 去重的文件块（blob）；每次发布保存完整文件清单。
 * 同一实例再次发布时，启动器与服务端清单比对，只上传缺失的文件块；
 * 移动文件复用已有 blob，删除文件只改清单。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const net = require('./net');
const safe = require('./safe');
const settingsLib = require('./settings');
const versions = require('./versions');
const dirs = require('./dirs');
const domains = require('./domains');
const installLib = require('./install');
const log = require('./log');

const API_PREFIX = '/api/plugins/launcher-domain';
const MARKER = '.swustmcl-pack.json';
const CHUNK = 8 * 1024 * 1024;
const MAX_FILES = 50_000;
const MAX_FILE = 2 * 1024 * 1024 * 1024;
const MAX_TOTAL = 20 * 1024 * 1024 * 1024;

const SKIP_DIRS = new Set([
  'logs', 'crash-reports', 'saves', 'screenshots', 'backups', 'downloads',
  'natives', '.git', '.mixin.out', 'pcl', '.cache', 'cache',
]);
const SKIP_FILES = new Set([
  'options.txt', 'servers.dat', 'usercache.json', 'launcher_profiles.json',
  'swustmcl-instance.json', MARKER,
]);

function domainById(id) {
  if (!id) return domains.active();
  return domains.find(String(id));
}

function requireSiteDomain(domain) {
  if (!domain || domain.personal) throw new Error('请先切换到站点型域');
  if (!domain.url) throw new Error('域地址为空，请刷新域清单');
  return domain;
}

function apiBase(domain) {
  return `${String(domain.url).replace(/\/+$/, '')}${API_PREFIX}`;
}

function tokenMap() {
  try {
    const value = settingsLib.getSecret('domainPublishTokens');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function publishToken(domainId) {
  return String(tokenMap()[domainId] || '');
}

function setPublishToken(domainId, token) {
  const all = { ...tokenMap() };
  const value = String(token || '').trim();
  if (value) all[domainId] = value;
  else delete all[domainId];
  settingsLib.setSecret('domainPublishTokens', all);
  return Boolean(value);
}

async function siteFetch(domain, pathname, { method = 'GET', token = '', body, timeout = 60000 } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers['X-SWUSTMCL-Publish-Token'] = token;
  let payload;
  if (body !== undefined) {
    if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
      headers['Content-Type'] = 'application/octet-stream';
      payload = body;
    } else {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }
  let response;
  try {
    response = await fetch(`${apiBase(domain)}${pathname}`, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw new Error(`连接皮肤站失败：${e.message}`);
  }
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    const message = data && data.error && data.error.message;
    throw new Error(message || `皮肤站返回 HTTP ${response.status}`);
  }
  if (data && data.ok === true && Object.prototype.hasOwnProperty.call(data, 'data')) return data.data;
  return data;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function loaderVersionOf(meta) {
  const names = ((meta && meta.libraries) || []).map((lib) => String((lib && lib.name) || ''));
  const pick = (prefix) => {
    const hit = names.find((name) => name.startsWith(prefix));
    return hit ? hit.slice(prefix.length).split(':')[0] : '';
  };
  return pick('net.neoforged:neoforge:')
    || pick('net.minecraftforge:forge:')
    || pick('net.fabricmc:fabric-loader:')
    || pick('org.quiltmc:quilt-loader:')
    || '';
}

async function collectFiles(instanceDir, instanceId) {
  const files = [];
  let total = 0;

  async function walk(current, relBase) {
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const lowerName = entry.name.toLowerCase();
        if (SKIP_DIRS.has(lowerName) || lowerName.includes('natives')) continue;
        await walk(path.join(current, entry.name), rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (SKIP_FILES.has(entry.name) || /\.log$/i.test(entry.name)) continue;
      if (!relBase && (entry.name === `${instanceId}.json` || entry.name === `${instanceId}.jar`)) continue;
      const full = path.join(current, entry.name);
      let stat;
      try { stat = await fsp.stat(full); } catch { continue; }
      if (stat.size > MAX_FILE) throw new Error(`文件过大：${rel}`);
      total += stat.size;
      if (total > MAX_TOTAL) throw new Error('实例体积超过 20 GB 上限');
      files.push({ path: rel, file: full, size: stat.size });
      if (files.length > MAX_FILES) throw new Error('文件数量超过 50000 上限');
    }
  }

  await walk(instanceDir, '');
  const out = new Array(files.length);
  let cursor = 0;
  const workers = new Array(Math.min(8, files.length || 1)).fill(0).map(async () => {
    for (;;) {
      const index = cursor++;
      const item = files[index];
      if (!item) return;
      out[index] = { path: item.path, hash: await sha256File(item.file), size: item.size, file: item.file };
    }
  });
  await Promise.all(workers);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return { files: out, totalSize: total };
}

async function scanInstance(dir, instanceId) {
  const mcDir = String(dir || '');
  const id = safe.assertVersionId(String(instanceId || ''), '实例名');
  const instanceDir = safe.safeJoin(path.join(mcDir, 'versions'), id);
  if (!fs.existsSync(instanceDir)) throw new Error('实例目录不存在');
  if (!dirs.isIsolatedInstance(instanceDir)) {
    throw new Error('只允许发布版本隔离实例：请先在实例设置中开启版本隔离，或复制为隔离实例');
  }
  const meta = versions.loadVersionJson(mcDir, id);
  const merged = JSON.parse(JSON.stringify(meta));
  merged.id = id;
  delete merged.inheritsFrom;
  const { files, totalSize } = await collectFiles(instanceDir, id);
  let originalId = id;
  try {
    const rawJson = versions.readJson(path.join(instanceDir, `${id}.json`));
    if (rawJson && rawJson.id) originalId = rawJson.id;
  } catch {}
  const displayName = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(instanceDir, 'swustmcl-instance.json'), 'utf8')).displayName || ''; } catch { return ''; }
  })();
  return {
    files,
    totalSize,
    instance: {
      id,
      name: displayName || id,
      mcVersion: versions.guessMcVersion(originalId, meta) || versions.guessMcVersion(id, meta) || '',
      loader: versions.loaderOf(id, meta.mainClass),
      loaderVersion: loaderVersionOf(meta),
      javaMajor: (meta.javaVersion && meta.javaVersion.majorVersion) || 8,
      versionJson: merged,
    },
  };
}

function readMarker(instanceDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(instanceDir, MARKER), 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeMarker(instanceDir, marker) {
  fs.writeFileSync(path.join(instanceDir, MARKER), JSON.stringify(marker, null, 2), 'utf8');
}

async function uploadBlob(domain, token, hash, file, size, onBytes) {
  const handle = await fsp.open(file, 'r');
  let offset = 0;
  try {
    while (offset < size) {
      const length = Math.min(CHUNK, size - offset);
      const buffer = Buffer.allocUnsafe(length);
      const read = await handle.read(buffer, 0, length, offset);
      if (read.bytesRead !== length) throw new Error('读取本地文件失败');
      let advance = false;
      for (let attempt = 0; attempt < 3 && !advance; attempt += 1) {
        try {
          const result = await siteFetch(
            domain,
            `/admin/pack/blob?hash=${hash}&offset=${offset}&total=${size}`,
            { method: 'PUT', token, body: buffer, timeout: 120000 }
          );
          if (result && result.done) {
            if (onBytes) onBytes(size - offset);
            return;
          }
          offset += length;
          if (onBytes) onBytes(length);
          advance = true;
        } catch (e) {
          if (attempt >= 2) throw e;
          if (/不连续|重新上传|校验失败/.test(e.message)) offset = 0;
          await net.sleep(500 * (attempt + 1));
        }
      }
    }
  } finally {
    await handle.close();
  }
}

async function publish({ domainId, dir, instanceId, serverId, policy, minJava, notes, name, description, onProgress }) {
  const domain = requireSiteDomain(domainById(domainId));
  const token = publishToken(domain.id);
  if (!token) throw new Error('尚未配置发布令牌，请先在域管理生成令牌');
  const scan = await scanInstance(dir, instanceId);
  const instanceDir = safe.safeJoin(path.join(dir, 'versions'), instanceId);
  const marker = readMarker(instanceDir);
  const sameDomain = marker.domainId === domain.id;
  const payload = {
    packId: sameDomain ? (marker.packId || '') : '',
    name: String(name || (sameDomain && marker.packName) || scan.instance.name).trim(),
    description: String(description || '').trim(),
    serverId: String(serverId || ''),
    policy: String(policy || 'optional'),
    minJava: Number(minJava) || 0,
    notes: String(notes || '').trim(),
    instance: scan.instance,
    files: scan.files.map((file) => ({ path: file.path, hash: file.hash, size: file.size })),
  };
  if (onProgress) onProgress({ stage: 'prepare', message: '正在比对站点版本…' });
  const prepared = await siteFetch(domain, '/admin/pack/prepare', {
    method: 'POST', token, body: payload, timeout: 120000,
  });
  const packId = prepared.packId;
  const diff = prepared.diff || {};
  const missing = Array.isArray(diff.missing) ? diff.missing : [];
  if (onProgress) onProgress({
    stage: 'diff',
    message: `新增 ${diff.added || 0} · 修改 ${diff.modified || 0} · 移动 ${diff.moved || 0} · 删除 ${diff.deleted || 0}`,
    diff,
  });

  const byHash = new Map();
  for (const file of scan.files) if (!byHash.has(file.hash)) byHash.set(file.hash, file);
  const uploadTotal = missing.reduce((sum, hash) => sum + ((byHash.get(hash) || {}).size || 0), 0);
  let uploaded = 0;
  let completed = 0;
  await net.pool(missing, 3, async (hash) => {
    const file = byHash.get(hash);
    if (!file) return;
    await uploadBlob(domain, token, hash, file.file, file.size, (bytes) => {
      uploaded += bytes;
      if (onProgress) onProgress({
        stage: 'upload',
        message: `上传新文件 ${completed + 1}/${missing.length}`,
        uploaded,
        total: uploadTotal,
      });
    });
    completed += 1;
    if (onProgress) onProgress({
      stage: 'upload',
      message: `上传新文件 ${completed}/${missing.length}`,
      uploaded,
      total: uploadTotal,
    });
  });

  if (onProgress) onProgress({ stage: 'commit', message: '正在提交新版本…' });
  const result = await siteFetch(domain, '/admin/pack/commit', {
    method: 'POST', token, body: { ...payload, packId }, timeout: 120000,
  });
  writeMarker(instanceDir, {
    domainId: domain.id,
    packId,
    packName: payload.name,
    serverId: payload.serverId,
    policy: payload.policy,
    minJava: payload.minJava,
    version: Number(result.latestVersion) || 0,
    instanceId,
    publishedAt: new Date().toISOString(),
    files: scan.files.map((file) => ({ path: file.path, hash: file.hash, size: file.size })),
  });
  log.info(`整合包已发布：${payload.name} v${result.latestVersion}（${scan.files.length} 个文件）`);
  return { packId, pack: result, diff, fileCount: scan.files.length, totalSize: scan.totalSize };
}

async function fetchPack(domain, { packId, serverId }) {
  const query = packId ? `id=${encodeURIComponent(packId)}` : `server=${encodeURIComponent(serverId)}`;
  return siteFetch(domain, `/pack?${query}`, { timeout: 120000 });
}

function uniqueInstanceId(mcDir, base) {
  const root = path.join(mcDir, 'versions');
  let name = String(base || 'DomainPack').replace(/[\\/:*?"<>|]/g, '-').replace(/^[.\s]+|[.\s]+$/g, '');
  if (!name) name = 'DomainPack';
  if (name.length > 60) name = name.slice(0, 60);
  let candidate = name;
  for (let i = 2; i < 500; i += 1) {
    if (!fs.existsSync(path.join(root, candidate))) return candidate;
    candidate = `${name}-${i}`;
  }
  return `${name}-${Date.now()}`;
}

async function syncPackFiles(domain, pack, instanceDir, oldMarker, onProgress) {
  const files = Array.isArray(pack.files) ? pack.files : [];
  let done = 0;
  let bytes = 0;
  const totalBytes = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
  const report = () => {
    if (onProgress) onProgress({
      stage: 'files', message: `同步整合包文件 ${done}/${files.length}`,
      done, total: files.length, bytes, totalBytes,
    });
  };
  await net.pool(files, 4, async (entry) => {
    const relative = String(entry.path || '');
    const dest = safe.safeJoin(instanceDir, relative);
    const hash = String(entry.hash || '').toLowerCase();
    const size = Number(entry.size) || 0;
    let need = true;
    try {
      const stat = await fsp.stat(dest);
      if (stat.size === size) need = (await sha256File(dest)) !== hash;
    } catch {
      need = true;
    }
    if (need) {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const url = `${apiBase(domain)}/blob?hash=${encodeURIComponent(hash)}`;
      await net.download(url, dest, {
        expectedSize: size,
        expectedSha256: hash,
        retries: 2,
        timeout: 60000,
        onBytes: (n) => { bytes += n; },
      });
    }
    done += 1;
    report();
  });
  if (oldMarker && Array.isArray(oldMarker.files)) {
    const nextPaths = new Set(files.map((file) => String(file.path || '')));
    for (const old of oldMarker.files) {
      const relative = String(old.path || '');
      if (!relative || nextPaths.has(relative)) continue;
      const target = safe.safeJoin(instanceDir, relative);
      await fsp.unlink(target).catch(() => {});
    }
  }
}

async function installPack({ domainId, packId, serverId, mcDir, instanceId, onProgress }) {
  const domain = requireSiteDomain(domainById(domainId));
  const pack = await fetchPack(domain, { packId, serverId });
  const targetMcDir = String(mcDir || '').trim() || settingsLib.ensureGameDir();
  const existingId = String(instanceId || '').trim();
  const id = existingId || uniqueInstanceId(targetMcDir, pack.name);
  safe.assertVersionId(id, '实例名');
  const instanceDir = safe.safeJoin(path.join(targetMcDir, 'versions'), id);
  const oldMarker = readMarker(instanceDir);
  const versionJson = pack.instance && pack.instance.versionJson;
  if (!versionJson || typeof versionJson !== 'object') throw new Error('整合包缺少版本配置，无法安装');
  const source = settingsLib.all().downloadSource === 'mojang' ? 'mojang' : 'bmcl';
  if (onProgress) onProgress({ stage: 'base', message: '正在准备基础版本与依赖…', percent: 1 });
  await installLib.install(id, { meta: { ...versionJson }, mcDir: targetMcDir }, source, (p) => {
    if (onProgress) onProgress({ stage: 'base', message: p.message || '正在安装基础版本…', percent: p.percent || 0 });
  });
  await fsp.mkdir(instanceDir, { recursive: true });
  if (onProgress) onProgress({ stage: 'files', message: '正在同步整合包文件…', done: 0, total: (pack.files || []).length });
  await syncPackFiles(domain, pack, instanceDir, oldMarker, onProgress);
  writeMarker(instanceDir, {
    domainId: domain.id,
    packId: pack.id,
    packName: pack.name,
    serverId: pack.serverId,
    policy: pack.policy,
    minJava: Number(pack.minJava) || 0,
    version: Number(pack.version && pack.version.version) || Number(pack.latestVersion) || 0,
    instanceId: id,
    publishedAt: new Date().toISOString(),
    files: (pack.files || []).map((file) => ({ path: file.path, hash: file.hash, size: file.size })),
  });
  log.info(`整合包已安装：${pack.name} v${pack.version && pack.version.version} → ${id}`);
  return {
    instanceId: id,
    dir: targetMcDir,
    version: Number(pack.version && pack.version.version) || 0,
    packId: pack.id,
    minJava: Number(pack.minJava) || 0,
  };
}

async function installVanilla({ mcVersion, onProgress }) {
  const mc = String(mcVersion || '').trim();
  if (!mc) throw new Error('整合包未记录 MC 版本，无法安装纯净原版');
  const manifest = await versions.getManifest();
  const entry = (manifest.versions || []).find((version) => version.id === mc);
  if (!entry) throw new Error(`版本清单里找不到 ${mc}`);
  const dir = settingsLib.ensureGameDir();
  const source = settingsLib.all().downloadSource === 'mojang' ? 'mojang' : 'bmcl';
  await installLib.install(mc, entry, source, (p) => {
    if (onProgress) onProgress({ stage: 'vanilla', message: p.message || '正在安装原版…', percent: p.percent || 0 });
  });
  return { instanceId: mc, dir };
}


module.exports = {
  scanInstance,
  publish,
  installPack,
  installVanilla,
  fetchPack,
  publishToken,
  setPublishToken,
  readMarker,
  apiBase,
  domainById,
};
