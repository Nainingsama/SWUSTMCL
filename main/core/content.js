'use strict';
/**
 * 资源（模组 / 光影 / 材质包 / 数据包）搜索与安装：Modrinth 为主，
 * CurseForge 为辅（需用户在设置里填 API Key；没有 key 时搜索不可用并给出提示）。
 *
 * 安装目标：指定实例。按实例的 MC 版本与加载器过滤，模组放 mods/，
 * 光影 shaderpacks/，材质 resourcepacks/。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const net = require('./net');
const safe = require('./safe');
const settingsLib = require('./settings');
const versionLib = require('./versions');
const log = require('./log');

const MODRINTH = 'https://api.modrinth.com/v2';

/**
 * MC百科 中文译名桥接：中文关键词 → 英文原名候选。
 * 解析 search.mcmod.cn 的结果条目（标题形如「中文名 (English Name)」）。
 * 用于资源搜索：Modrinth/CF 都以英文索引，中文先经此翻译。
 */
const translation = require('./translation');

async function chineseAlias(query) {
  // 离线译名库：命中直接返回（零延迟），未命中走 MC百科 在线并学习
  const local = translation.lookup(query);
  if (local) {
    return [{ mcmodId: '', zh: query, en: local, offline: true }];
  }
  const url = `https://search.mcmod.cn/s?key=${encodeURIComponent(query)}&filter=mod`;
  const html = await net.fetchJson(url, { raw: true, timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0 (SWUSTMCL)' } });
  const out = [];
  const re = /<a[^>]+href="https:\/\/www\.mcmod\.cn\/class\/(\d+)\.html"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(String(html))) && out.length < 5) {
    const title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const en = (title.match(/[(（]([^)）]{2,60})[)）]/) || [])[1] || '';
    if (en && /[a-zA-Z]{2,}/.test(en)) {
      out.push({
        mcmodId: m[1],
        zh: title.replace(/[(（][^)）]*[)）]\s*$/, '').trim(),
        en: en.trim(),
      });
    }
  }
  return out;
}

// projectId → 标题缓存（前置依赖显示用，避免重复请求）
const depTitleCache = new Map();
async function depTitle(projectId) {
  if (!projectId) return '';
  if (depTitleCache.has(projectId)) return depTitleCache.get(projectId);
  let t = '';
  try {
    const j = await net.fetchJson(`${MODRINTH}/project/${encodeURIComponent(projectId)}`, { timeout: 10000 });
    t = (j && j.title) || '';
  } catch {}
  depTitleCache.set(projectId, t);
  return t;
}
const CURSEFORGE = 'https://api.curseforge.com/v1';

const PROJECT_TYPES = {
  mod: { modrinth: 'mod', cf: 6, dir: 'mods' },
  shader: { modrinth: 'shader', cf: 6552, dir: 'shaderpacks' },
  resourcepack: { modrinth: 'resourcepack', cf: 12, dir: 'resourcepacks' },
  datapack: { modrinth: 'datapack', cf: 6, dir: 'datapacks' },
  modpack: { modrinth: 'modpack', cf: 4471, dir: '' },
};

let builtinCfKeyCache;
// 发布者内置的 CurseForge Key（build 时写入本目录 cf-key.json，该文件不进 git）。
// 与 PCL/HMCL 相同的做法：作者向 CurseForge 申请 Key 随启动器分发，玩家无需填写。
function builtinCfKey() {
  if (builtinCfKeyCache !== undefined) return builtinCfKeyCache;
  try {
    builtinCfKeyCache = JSON.parse(fs.readFileSync(path.join(__dirname, 'cf-key.json'), 'utf8')).key || '';
  } catch {
    builtinCfKeyCache = '';
  }
  return builtinCfKeyCache;
}

function hasCfKey() {
  return Boolean((settingsLib.all().cfApiKey || '').trim() || builtinCfKey());
}

function cfHeaders() {
  const key = (settingsLib.all().cfApiKey || '').trim() || builtinCfKey();
  return { 'x-api-key': key, Accept: 'application/json' };
}

/**
 * 搜索
 * @param {object} q { source:'modrinth'|'curseforge', type:'mod'|'shader'|'resourcepack'|'modpack', query, gameVersion, loader, offset, limit }
 */
async function search(q) {
  const type = PROJECT_TYPES[q.type] || PROJECT_TYPES.mod;
  const limit = Math.min(50, Math.max(5, Number(q.limit) || 20));
  const offset = Math.max(0, Number(q.offset) || 0);

  if (q.source !== 'curseforge') {
    const facets = [
      [`project_type:${type.modrinth}`],
    ];
    // 空关键词查热门：不带版本过滤（新版本往往 0 适配，避免空结果）
    if (q.gameVersion && q.query) facets.push([`versions:${q.gameVersion}`]);
    if (q.loader && q.type === 'mod') facets.push([`categories:${q.loader.toLowerCase()}`]);
    const params = new URLSearchParams({
      query: q.query || '',
      limit: String(limit),
      offset: String(offset),
      facets: JSON.stringify(facets),
    });
    const data = await net.fetchJson(`${MODRINTH}/search?${params}`, { timeout: 15000 });
    return {
      source: 'modrinth',
      total: data.total_hits || 0,
      hits: (data.hits || []).map((h) => ({
        id: h.project_id,
        slug: h.slug,
        title: h.title,
        description: h.description,
        author: h.author,
        downloads: h.downloads,
        follows: h.follows,
        iconUrl: h.icon_url || '',
        dateModified: h.date_modified,
        versions: (h.versions || []).slice(-3),
        categories: (h.categories || []).slice(0, 4),
      })),
    };
  }

  // CurseForge
  if (!(settingsLib.all().cfApiKey || '').trim()) {
    throw new Error('CurseForge 搜索需要在设置里填写 API Key（可在 console.curseforge.com 免费申请）');
  }
  const params = new URLSearchParams({
    gameId: '432', // Minecraft
    classId: String(type.cf),
    searchFilter: q.query || '',
    gameVersion: q.gameVersion || '',
    sortField: '2', // Popularity
    sortOrder: 'desc',
    pageSize: String(limit),
    index: String(offset),
  });
  const data = await net.fetchJson(`${CURSEFORGE}/mods/search?${params}`, { headers: cfHeaders(), timeout: 15000 });
  return {
    source: 'curseforge',
    total: (data.data && data.data.length) || 0,
    hits: (data.data || []).map((m) => ({
      id: String(m.id),
      slug: m.slug,
      title: m.name,
      description: m.summary || '',
      author: (m.authors && m.authors[0] && m.authors[0].name) || '',
      downloads: m.downloadCount,
      follows: m.thumbsUpCount || 0,
      iconUrl: (m.logo && m.logo.thumbnailUrl) || '',
      dateModified: m.dateModified,
      versions: (m.latestFilesIndexes || []).slice(0, 3).map((f) => f.gameVersion),
      categories: (m.categories || []).slice(0, 4).map((c) => c.name),
    })),
  };
}

/** 项目下的可选文件版本 */
async function versions(source, projectId, q = {}) {
  if (source !== 'curseforge') {
    const data = await net.fetchJson(`${MODRINTH}/project/${encodeURIComponent(projectId)}/version`, { timeout: 15000 });
    let list = data || [];
    // 按发布时间倒序（新版在前）
    list = list.slice().sort((a, b) => (Date.parse(b.date_published) || 0) - (Date.parse(a.date_published) || 0));
    if (q.gameVersion) list = list.filter((v) => (v.game_versions || []).includes(q.gameVersion));
    if (q.loader && q.type === 'mod') list = list.filter((v) => (v.loaders || []).map((x) => x.toLowerCase()).includes(q.loader.toLowerCase()));
    return Promise.all(list.slice(0, 30).map(async (v) => ({
      id: v.id,
      name: v.name,
      versionNumber: v.version_number,
      date: v.date_published,
      gameVersions: (v.game_versions || []).slice(0, 5),
      loaders: v.loaders || [],
      files: (v.files || []).map((f) => ({
        url: f.url,
        filename: f.filename,
        size: f.size,
        hashSha1: (f.hashes && f.hashes.sha1) || '',
        primary: Boolean(f.primary),
      })),
      dependencies: await Promise.all((v.dependencies || []).map(async (d) => ({
        projectId: d.project_id,
        title: d.dependency_type === 'required' && d.project_id ? await depTitle(d.project_id) : '',
        type: d.dependency_type, // required / optional / embedded
      }))),
    })));
  }

  if (!(settingsLib.all().cfApiKey || '').trim()) throw new Error('需要在设置里填写 CurseForge API Key');
  const data = await net.fetchJson(`${CURSEFORGE}/mods/${encodeURIComponent(projectId)}/files`, { headers: cfHeaders(), timeout: 15000 });
  let list = (data.data || []).map((f) => ({
    id: String(f.id),
    name: f.displayName || f.fileName,
    versionNumber: f.displayName || f.fileName,
    date: f.fileDate,
    gameVersions: f.gameVersions || [],
    loaders: /fabric/i.test(f.gameVersions && f.gameVersions.join(',')) ? ['fabric'] : [],
    files: [{
      url: f.downloadUrl || '',
      filename: f.fileName,
      size: f.fileLength || 0,
      hashSha1: '',
      primary: true,
    }],
    dependencies: [],
  }));
  list = list.slice().sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0)); // 新版在前
  if (q.gameVersion) list = list.filter((v) => v.gameVersions.includes(q.gameVersion));
  return list.slice(0, 30);
}

/**
 * 计算安装清单：主文件 + 缺失依赖（依赖已装则跳过）。
 * @returns {{items:[{url, filename, size, sha1, dir, dep}], missingDeps:[{projectId, reason}]}}
 */
async function planInstall(payload) {
  const { source, projectId, versionId, instance, dir: mcDir, type = 'mod' } = payload;
  const kind = PROJECT_TYPES[type] || PROJECT_TYPES.mod;
  const instDir = safe.safeJoin(path.join(mcDir, 'versions'), instance);
  const targetDir = kind.dir ? path.join(instDir, kind.dir) : instDir;

  const installed = new Set();
  try {
    for (const f of await fsp.readdir(targetDir)) {
      if (f.endsWith('.jar') || f.endsWith('.zip')) installed.add(f.toLowerCase());
    }
  } catch {}

  const meta = versionLib.loadVersionJson(mcDir, instance);
  const gameVersion = versionLib.guessMcVersion(instance, meta);

  let items = [];
  const missingDeps = [];

  if (source !== 'curseforge') {
    const ver = (await net.fetchJson(`${MODRINTH}/version/${encodeURIComponent(versionId)}`, { timeout: 15000 }));
    const file = (ver.files || []).find((f) => f.primary) || (ver.files || [])[0];
    if (!file) throw new Error('该版本没有可用文件');
    items.push({ url: file.url, filename: file.filename, size: file.size, sha1: (file.hashes && file.hashes.sha1) || '', dir: targetDir, dep: false });
    for (const d of ver.dependencies || []) {
      if (d.dependency_type !== 'required' || !d.project_id) continue;
      const depMeta = await net.fetchJson(`${MODRINTH}/project/${d.project_id}`, { timeout: 15000 }).catch(() => null);
      if (!depMeta) continue;
      // 注意：facets 必须 URL 编码，裸 ["26.3"] 会被 Modrinth 拒绝返回空（前置就一直下不上）
      const gvFacet = encodeURIComponent(JSON.stringify([gameVersion]));
      const ldFacet = encodeURIComponent(JSON.stringify([(ver.loaders || ['fabric'])[0]]));
      let depVers = await net.fetchJson(`${MODRINTH}/project/${d.project_id}/version?game_versions=${gvFacet}&loaders=${ldFacet}`, { timeout: 15000 }).catch(() => []);
      if (!Array.isArray(depVers) || !depVers.length) {
        // 精确版本没有：放宽到仅按游戏版本找（前置版本号常滞后）
        depVers = await net.fetchJson(`${MODRINTH}/project/${d.project_id}/version?game_versions=${gvFacet}`, { timeout: 15000 }).catch(() => []);
      }
      if (!Array.isArray(depVers) || !depVers.length) {
        log.warn(`前置 ${depMeta.title || d.project_id} 没有适配 ${gameVersion} 的版本，跳过自动安装`);
      }
      const dv = (depVers || [])[0];
      const depFile = dv && ((dv.files || []).find((f) => f.primary) || (dv.files || [])[0]);
      if (!depFile) continue;
      const isInstalled = installed.has(depFile.filename.toLowerCase());
      if (isInstalled) continue;
      items.push({ url: depFile.url, filename: depFile.filename, size: depFile.size, sha1: (depFile.hashes && depFile.hashes.sha1) || '', dir: targetDir, dep: true });
    }
  } else {
    if (!(settingsLib.all().cfApiKey || '').trim()) throw new Error('需要在设置里填写 CurseForge API Key');
    const f = await net.fetchJson(`${CURSEFORGE}/mods/${encodeURIComponent(projectId)}/files/${encodeURIComponent(versionId)}`, { headers: cfHeaders(), timeout: 15000 });
    const file = f.data || {};
    if (!file.downloadUrl) throw new Error('该文件没有直链（CF 限制），请改用 Modrinth 源');
    items.push({ url: file.downloadUrl, filename: file.fileName, size: file.fileLength || 0, sha1: '', dir: targetDir, dep: false });
  }

  return { items, gameVersion, installedAlready: items.every((i) => installed.has(String(i.filename).toLowerCase())) };
}

/** 执行安装（下载到实例目录），onProgress 汇报 */
async function install(payload, onProgress) {
  const plan = await planInstall(payload);
  const report = (p) => onProgress && onProgress(p);
  const results = [];
  for (const [i, item] of plan.items.entries()) {
    report({ stage: 'download', message: `下载 ${item.filename}（${i + 1}/${plan.items.length}）`, percent: Math.round((i / Math.max(1, plan.items.length)) * 100) });
    const dest = safe.safeJoin(item.dir, item.filename);
    await net.download(item.url, dest, {
      expectedSize: item.size || 0,
      expectedSha1: item.sha1 || '',
      expectZip: /\.(jar|zip)$/i.test(dest),
      retries: 2,
    });
    results.push({ filename: item.filename, dep: item.dep, path: dest });
  }
  report({ stage: 'done', message: '安装完成', percent: 100 });
  log.info(`资源安装完成：${results.map((r) => r.filename).join('、')}`);
  return { ok: true, files: results };
}

module.exports = { search, versions, planInstall, install, chineseAlias, hasCfKey };
