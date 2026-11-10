'use strict';
/**
 * 启动器「域」：添加站点型域、缓存 manifest、下载域内资源。
 * 域清单协议 v1：站点部署 launcher-domain 插件后提供
 * GET <base>/api/plugins/launcher-domain/manifest
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const net = require('./net');
const safe = require('./safe');

const MANIFEST_PATH = '/api/plugins/launcher-domain/manifest';
const STORE_VERSION = 1;

function storePath() {
  return path.join(app.getPath('userData'), 'domains.json');
}

function readStore() {
  try {
    const value = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    if (value && value.version === STORE_VERSION && Array.isArray(value.items)) return value;
  } catch {}
  return { version: STORE_VERSION, items: [] };
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), 'utf8');
}

function decodeInvite(input) {
  let value = String(input || '').trim();
  if (!value) throw new Error('请填写域地址或邀请内容');
  if (value.startsWith('swustmcl:domain:')) value = decodeURIComponent(value.slice('swustmcl:domain:'.length));
  else if (value.startsWith('ymcl:site:')) value = decodeURIComponent(value.slice('ymcl:site:'.length));
  else if (/^swustmcl:\/\/add-domain/i.test(value)) {
    const url = new URL(value);
    value = url.searchParams.get('url') || '';
  } else if (/^swustmcl:\/\//i.test(value)) {
    throw new Error('不支持的启动器邀请');
  }
  return value.trim();
}

function normalizeBase(input) {
  let value = decodeInvite(input);
  if (!value) throw new Error('邀请中没有域地址');
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  let url;
  try { url = new URL(value); } catch { throw new Error('域地址格式不正确'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('域地址只支持 http/https');
  let pathname = url.pathname.replace(/\/+$/, '');
  if (pathname.endsWith(MANIFEST_PATH)) pathname = pathname.slice(0, -MANIFEST_PATH.length);
  return `${url.origin}${pathname}`;
}

function manifestUrl(base) {
  return `${base}${MANIFEST_PATH}`;
}

function resolveUrl(value, base) {
  if (!value) return '';
  try { return new URL(String(value), base.endsWith('/') ? base : `${base}/`).toString(); } catch { return ''; }
}

function normalizeServer(raw, base) {
  if (!raw || typeof raw !== 'object') return null;
  const host = String(raw.host || '').trim();
  const port = Math.min(65535, Math.max(1, Number(raw.port) || 25565));
  if (!host) return null;
  return {
    id: String(raw.id || `${host}:${port}`),
    name: String(raw.name || host).slice(0, 60),
    host,
    port,
    note: String(raw.note || '').slice(0, 200),
    icon: resolveUrl(raw.icon, base),
    sortOrder: Number(raw.sortOrder) || 0,
    online: Boolean(raw.online),
    onlineCount: Number(raw.onlineCount) || 0,
    maxPlayers: Number(raw.maxPlayers) || 0,
    version: String(raw.version || ''),
    lastSeenAt: raw.lastSeenAt || null,
  };
}

function normalizeResource(raw, base) {
  if (!raw || typeof raw !== 'object') return null;
  const url = resolveUrl(raw.url, base);
  if (!url || !safe.isHttpUrl(url)) return null;
  const type = ['modpack', 'resourcepack', 'shaderpack', 'other'].includes(raw.type) ? raw.type : 'other';
  return {
    id: String(raw.id || url),
    name: String(raw.name || '未命名资源').slice(0, 80),
    description: String(raw.description || '').slice(0, 500),
    type,
    url,
    sha256: /^[0-9a-f]{64}$/i.test(String(raw.sha256 || '')) ? String(raw.sha256).toLowerCase() : '',
    size: Math.max(0, Number(raw.size) || 0),
    version: String(raw.version || '').slice(0, 40),
    icon: resolveUrl(raw.icon, base),
  };
}

function normalizeManifest(raw, base) {
  if (!raw || typeof raw !== 'object') throw new Error('域清单不是有效的 JSON 对象');
  if (Number(raw.version) !== 1) throw new Error('域清单协议版本不受支持');
  const servers = (Array.isArray(raw.servers) ? raw.servers : []).map((s) => normalizeServer(s, base)).filter(Boolean);
  const resources = (Array.isArray(raw.resources) ? raw.resources : []).map((r) => normalizeResource(r, base)).filter(Boolean);
  const auth = raw.auth && typeof raw.auth === 'object' ? raw.auth : {};
  return {
    version: 1,
    id: String(raw.id || 'domain').slice(0, 80),
    name: String(raw.name || '社团域').slice(0, 60),
    description: String(raw.description || '').slice(0, 300),
    icon: resolveUrl(raw.icon, base),
    siteUrl: resolveUrl(raw.siteUrl, base) || base,
    yggdrasilUrl: resolveUrl(raw.yggdrasilUrl || auth.yggdrasilUrl, base),
    announcement: {
      text: String((raw.announcement && raw.announcement.text) || '').slice(0, 2000),
      updatedAt: (raw.announcement && raw.announcement.updatedAt) || null,
    },
    auth: {
      yggdrasilUrl: resolveUrl(auth.yggdrasilUrl || raw.yggdrasilUrl, base),
      loginUrl: String(auth.loginUrl || ''),
      playersUrl: String(auth.playersUrl || ''),
    },
    servers,
    resources,
    updatedAt: raw.updatedAt || null,
  };
}

async function fetchManifest(base) {
  const response = await net.fetchJson(manifestUrl(base), { timeout: 15000, retries: 1 });
  const raw = response && response.data && typeof response.data === 'object' ? response.data : response;
  return normalizeManifest(raw, base);
}

function list() {
  return readStore().items;
}

function find(id) {
  return readStore().items.find((item) => item.id === id) || null;
}

async function add(input) {
  const base = normalizeBase(input);
  const store = readStore();
  const existing = store.items.find((item) => item.url === base);
  if (existing) return refresh(existing.id);
  const manifest = await fetchManifest(base);
  const item = {
    id: base,
    url: base,
    name: manifest.name,
    icon: manifest.icon,
    manifest,
    fetchedAt: new Date().toISOString(),
    error: '',
  };
  store.items.push(item);
  writeStore(store);
  return item;
}

async function refresh(id) {
  const store = readStore();
  const item = store.items.find((entry) => entry.id === id);
  if (!item) throw new Error('域不存在');
  try {
    item.manifest = await fetchManifest(item.url);
    item.name = item.manifest.name;
    item.icon = item.manifest.icon;
    item.fetchedAt = new Date().toISOString();
    item.error = '';
    writeStore(store);
    return item;
  } catch (error) {
    item.error = error.message || '刷新失败';
    writeStore(store);
    throw error;
  }
}

function remove(id) {
  const store = readStore();
  const before = store.items.length;
  store.items = store.items.filter((item) => item.id !== id);
  if (store.items.length === before) throw new Error('域不存在');
  writeStore(store);
  return true;
}

function safeFileName(value, fallback) {
  const name = path.basename(String(value || '')).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return name || fallback;
}

function resourceFile(domainId, resource) {
  const dir = path.join(app.getPath('userData'), 'domain-resources', safeFileName(domainId, 'domain'));
  let name = '';
  try { name = decodeURIComponent(new URL(resource.url).pathname.split('/').pop() || ''); } catch {}
  return path.join(dir, safeFileName(name, `${safeFileName(resource.name, 'resource')}.bin`));
}

async function downloadResource(domainId, resourceId, onProgress) {
  const domain = find(domainId);
  if (!domain) throw new Error('域不存在');
  const resource = (domain.manifest.resources || []).find((item) => item.id === resourceId);
  if (!resource) throw new Error('资源不存在');
  if (!safe.isHttpUrl(resource.url)) throw new Error('资源地址不安全');
  const dest = resourceFile(domainId, resource);
  const result = await net.downloadLarge(resource.url, dest, {
    expectedSize: resource.size || 0,
    expectedSha256: resource.sha256 || '',
    retries: 2,
    onBytes: onProgress ? (received) => onProgress(received, resource.size || 0) : null,
  });
  return { path: dest, name: path.basename(dest), type: resource.type, size: result.size || resource.size || 0 };
}

async function installResource(domainId, resourceId, instanceDir, onProgress) {
  const resource = (find(domainId)?.manifest.resources || []).find((item) => item.id === resourceId);
  if (!resource) throw new Error('资源不存在');
  const dir = path.resolve(String(instanceDir || ''));
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('实例目录不存在');
  const file = await downloadResource(domainId, resourceId, onProgress);
  if (resource.type === 'modpack') return file;
  if (resource.type !== 'resourcepack' && resource.type !== 'shaderpack') {
    throw new Error('该资源不支持自动安装，请使用下载');
  }
  const sub = resource.type === 'shaderpack' ? 'shaderpacks' : 'resourcepacks';
  const targetDir = path.join(dir, sub);
  fs.mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, path.basename(file.path));
  fs.copyFileSync(file.path, target);
  return { ...file, path: target, installed: true };
}

module.exports = { list, add, refresh, remove, downloadResource, installResource, normalizeBase, manifestUrl };
