'use strict';
/**
 * 整合包导入 / 导出。
 *
 * 支持三种清单格式：
 *   - Modrinth：modrinth.index.json（files[] 带 hashes.size.downloads）
 *   - CurseForge：manifest.json（files[] 带 projectID/fileID，走 CF API 或 cfwidget）
 *   - MCBBS / PCL / HMCL 导出：pack.mcmeta(mcbbs 格式) 或纯目录打包
 *     （根目录直接是 mods/config/saves 等 overrides）
 *
 * 导入流程：inspect（预览）→ 同名实例自动改名 → 建版本隔离实例 →
 * 安装底座与加载器 → 解包 overrides → 下载清单文件 → 校验依赖。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const AdmZip = require('adm-zip');

const safe = require('./safe');
const settingsLib = require('./settings');
const versionLib = require('./versions');
const log = require('./log');
const net = require('./net');

const SKIP_TOP = new Set(['launcher_profiles.json', 'launcher_accounts.json', 'logs', 'crash-reports', 'screenshots', '.fabric', 'CACHE', 'usercache.json']);

function readZip(file) {
  const zip = new AdmZip(file);
  return { zip, entries: zip.getEntries() };
}

/**
 * 解析整合包结构，返回预览信息（不动磁盘）。
 * @returns {null | {format, name, mcVersion, loader, loaderVersion, modCount, files:[{path,size,downloads,hashes,projectID,fileID}], overridesDir}}
 */
function inspect(file) {
  let zip, entries;
  try {
    ({ zip, entries } = readZip(file));
  } catch {
    throw new Error('无法读取整合包文件（需要 .mrpack 或 .zip）');
  }

  const findEntry = (name) => entries.find((e) => e.entryName.replace(/\\/g, '/') === name && !e.isDirectory);
  let manifest = null;
  let format = '';
  let overridesDir = 'overrides';

  const mrEntry = findEntry('modrinth.index.json');
  const cfEntry = findEntry('manifest.json');
  const mcbbsEntry = findEntry('mcbbs.packmeta') || findEntry('pack.mcmeta');

  if (mrEntry) {
    manifest = JSON.parse(zip.readAsText(mrEntry));
    format = 'modrinth';
  } else if (cfEntry) {
    manifest = JSON.parse(zip.readAsText(cfEntry));
    if (manifest && manifest.minecraft) format = 'curseforge';
  } else if (mcbbsEntry) {
    manifest = JSON.parse(zip.readAsText(mcbbsEntry));
    if (manifest && (manifest.files || manifest.launcherMeta)) format = 'mcbbs';
  }

  if (!manifest) {
    // PCL / HMCL 导出的裸目录包：根目录直接是 mods/ config/ 等
    const hasOverrides = entries.some((e) => {
      const n = e.entryName.replace(/\\/g, '/');
      return /^mods\//.test(n) || /^config\//.test(n) || /^saves\//.test(n) || /^options\.txt$/.test(n);
    });
    if (!hasOverrides) throw new Error('无法识别的整合包格式（缺少 modrinth.index.json / manifest.json / mods 目录）');
    format = 'raw';
    const modCount = entries.filter((e) => /^mods\/[^/]+\.jar$/i.test(e.entryName.replace(/\\/g, '/'))).length;
    return { format, name: path.basename(file).replace(/\.(zip|mrpack)$/i, ''), mcVersion: '', loader: '', loaderVersion: '', modCount, files: [], overridesDir: '' };
  }

  let mcVersion = '', loader = '', loaderVersion = '';
  const files = [];

  if (format === 'modrinth') {
    mcVersion = ((manifest.dependencies && manifest.dependencies.minecraft) || '').replace(/^.*?(\d+\.\d+.*)$/, '$1');
    for (const [k, v] of Object.entries(manifest.dependencies || {})) {
      if (k === 'fabric-loader') { loader = 'Fabric'; loaderVersion = v; }
      if (k === 'quilt-loader') { loader = 'Quilt'; loaderVersion = v; }
      if (k === 'forge') { loader = 'Forge'; loaderVersion = v; }
      if (k === 'neoforge') { loader = 'NeoForge'; loaderVersion = v; }
    }
    for (const f of manifest.files || []) {
      if (!f || f.path !== safe.safeEntryName(f.path)) continue; // 穿越路径直接丢弃
      files.push({
        path: f.path,
        size: (f.sizes && f.sizes.file) || f.fileSize || f.size || 0,
        hashes: f.hashes || {},
        downloads: f.downloads || [],
        env: f.env || null,
      });
    }
  } else if (format === 'curseforge') {
    mcVersion = (manifest.minecraft && manifest.minecraft.version) || '';
    for (const m of (manifest.minecraft && manifest.minecraft.modLoaders) || []) {
      const mm = String(m.id || '').match(/^(forge|neoforge|fabric|quilt)-(.+)$/);
      if (mm) {
        loader = mm[1] === 'forge' ? 'Forge' : mm[1] === 'neoforge' ? 'NeoForge' : mm[1] === 'fabric' ? 'Fabric' : 'Quilt';
        loaderVersion = mm[2];
      }
    }
    overridesDir = manifest.overrides || 'overrides';
    for (const f of manifest.files || []) {
      files.push({ path: '', projectID: f.projectID, fileID: f.fileID, required: f.required !== false });
    }
  } else if (format === 'mcbbs') {
    const v = manifest.launcherMeta || {};
    mcVersion = (manifest.launcherVersion || v.version || '') && (manifest.version || '');
    loader = (v.loader && v.loader.type) ? v.loader.type : '';
    loaderVersion = (v.loader && v.loader.version) || '';
    for (const f of manifest.files || []) {
      if (f.path !== safe.safeEntryName(f.path)) continue;
      files.push({
        path: f.path,
        size: (f.size || 0),
        hashes: (f.hashes && typeof f.hashes === 'object') ? { sha1: f.hashes.sha1 } : {},
        downloads: Array.isArray(f.downloads) ? f.downloads.filter((u) => typeof u === 'string') : [],
        force: Boolean(f.force),
      });
    }
  }

  // overrides 里的 mod 数量
  const ovPrefix = `${overridesDir.replace(/\/+$/, '')}/`;
  const modCount =
    files.filter((f) => /\.jar$/i.test(f.path || '')).length +
    entries.filter((e) => {
      const n = e.entryName.replace(/\\/g, '/');
      return n.startsWith(`${ovPrefix}mods/`) && /\.jar$/i.test(n);
    }).length;

  return {
    format,
    name: manifest.name || path.basename(file).replace(/\.(zip|mrpack)$/i, ''),
    version: manifest.version || '',
    author: manifest.author || (manifest.authors || []).map((a) => a.name).join(', '),
    description: manifest.summary || '',
    mcVersion,
    loader,
    loaderVersion,
    modCount,
    files,
    overridesDir,
    entryCount: entries.length,
  };
}

/** 目标实例名与现有实例同名时自动加序号：「Fabric 1.20.1」→「Fabric 1.20.1 (2)」 */
function uniqueInstanceId(mcDir, base) {
  let id = base;
  const taken = () => fs.existsSync(path.join(mcDir, 'versions', id));
  if (!taken()) return id;
  for (let i = 2; i < 500; i++) {
    id = `${base} (${i})`;
    if (!taken()) return id;
  }
  return `${base}-${Date.now()}`;
}

/**
 * 导入整合包。返回 { id, warnings }。
 * @param {string} file zip 路径
 * @param {object} info inspect 的返回
 * @param {object} hooks { onProgress, installVanilla, installLoader }
 */
async function importPack(file, info, hooks = {}) {
  const report = (p) => hooks.onProgress && hooks.onProgress(p);
  const warnings = [];
  const mcDir = settingsLib.ensureGameDir();
  const { zip, entries } = readZip(file);

  const baseName = (info.name || path.basename(file).replace(/\.(zip|mrpack)$/i, '')).replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 48) || '整合包实例';
  // 同名目录若还带导入标记（上次取消/中断），直接复用，已下载的 .part 可以续传
  let instanceId = baseName;
  const resumeDir = safe.safeJoin(path.join(mcDir, 'versions'), instanceId);
  let resuming = false;
  try {
    if (fs.existsSync(path.join(resumeDir, '.swustmcl-importing'))) resuming = true;
    else {
      // 旧版合并 bug 留下的实例（没有 inheritsFrom 也丢了 classpath）按损坏处理，同名导入直接覆盖修复
      const jp = path.join(resumeDir, instanceId + '.json');
      if (fs.existsSync(jp)) {
        const j = JSON.parse(fs.readFileSync(jp, 'utf8'));
        const jvm = JSON.stringify((j.arguments && j.arguments.jvm) || '');
        if (!j.inheritsFrom && !jvm.includes('classpath') && !j.minecraftArguments) resuming = true;
      }
    }
  } catch {}
  if (!resuming) instanceId = uniqueInstanceId(mcDir, baseName);
  safe.assertVersionId(instanceId);
  const instanceDir = safe.safeJoin(path.join(mcDir, 'versions'), instanceId);
  await fsp.mkdir(instanceDir, { recursive: true });
  if (hooks.onInstance) hooks.onInstance(instanceId, instanceDir);
  const importingMarker = path.join(instanceDir, '.swustmcl-importing');
  try { fs.writeFileSync(importingMarker, new Date().toISOString(), 'utf8'); } catch {}

  // ---------- 1. 底座与加载器 ----------
  let needBase = false;
  if (info.mcVersion) {
    needBase = (() => {
      try { versionLib.loadVersionJson(mcDir, info.mcVersion); return false; } catch { return true; }
    })();
    if (needBase) {
      report({ stage: 'base', message: `安装原版 ${info.mcVersion}`, percent: 2 });
      if (hooks.installVanilla) {
        const r = await hooks.installVanilla(info.mcVersion, (p) => report({ ...p, stage: 'base', percent: Math.min(45, Math.round((p.percent || 0) * 0.45)) }));
        if (!r.ok) throw new Error(`原版底座安装失败：${r.error}`);
      }
    } else {
      log.info(`底座 ${info.mcVersion} 已存在，跳过`);
    }
    if (info.loader && info.loaderVersion && hooks.installLoader) {
      report({ stage: 'loader', message: `安装 ${info.loader} ${info.loaderVersion}`, percent: 46 });
      await hooks.installLoader(
        info.loader.toLowerCase(), info.mcVersion, info.loaderVersion,
        instanceId,
        (p) => report({ ...p, stage: 'loader', percent: 46 + Math.min(24, Math.round((p.percent || 0) * 0.24)) })
      );
    }
  }

  // ---------- 1.5 合并底座：一个整合包实例只占一个 versions 目录 ----------
  if (info.mcVersion) {
    try {
      const instJsonPath = path.join(instanceDir, `${instanceId}.json`);
      if (!fs.existsSync(instJsonPath)) {
        throw new Error('加载器安装没有生成实例配置（' + instanceId + '.json），已中止导入');
      }
      const instJson = JSON.parse(fs.readFileSync(instJsonPath, 'utf8'));
      const parentId = instJson.inheritsFrom;
      if (parentId) {
        const merged = versionLib.loadVersionJson(mcDir, parentId); // 已沿继承链合并
        const libKey = (lib) => {
          const parts = String((lib && lib.name) || '').split(':');
          return parts.length >= 2 ? parts[0] + ':' + parts[1] + ':' + (parts[3] || '') : String((lib && lib.name) || '');
        };
        const libs = [];
        const seen = new Set();
        for (const l of [...(merged.libraries || []), ...(instJson.libraries || [])]) {
          const k = libKey(l);
          if (seen.has(k)) {
            const i = libs.findIndex((x) => libKey(x) === k);
            if (i >= 0) libs[i] = l; // 子版本覆盖同坐标库
          } else { seen.add(k); libs.push(l); }
        }
        const args = {
          game: [...((merged.arguments && merged.arguments.game) || []), ...((instJson.arguments && instJson.arguments.game) || [])],
          jvm: [...((merged.arguments && merged.arguments.jvm) || []), ...((instJson.arguments && instJson.arguments.jvm) || [])],
        };
        const out = {
          ...merged,
          ...instJson,
          id: instanceId,
          libraries: libs,
          arguments: args,
        };
        if (!out.minecraftArguments && merged.minecraftArguments) out.minecraftArguments = merged.minecraftArguments;
        delete out.inheritsFrom;
        const instJar = path.join(instanceDir, `${instanceId}.jar`);
        if (!fs.existsSync(instJar)) {
          const parentJar = path.join(mcDir, 'versions', parentId, `${parentId}.jar`);
          if (fs.existsSync(parentJar)) fs.copyFileSync(parentJar, instJar);
        }
        // 父版本是否还被别的实例继承
        let usedByOthers = false;
        try {
          const vroot = path.join(mcDir, 'versions');
          for (const d of fs.readdirSync(vroot)) {
            if (d === parentId || d === instanceId) continue;
            try {
              const j = JSON.parse(fs.readFileSync(path.join(vroot, d, `${d}.json`), 'utf8'));
              if (j.inheritsFrom === parentId) { usedByOthers = true; break; }
            } catch {}
          }
        } catch {}
        fs.writeFileSync(instJsonPath, JSON.stringify(out, null, 2), 'utf8');
        try {
          const metaFile = path.join(instanceDir, 'swustmcl-instance.json');
          const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
          meta.mergedFrom = parentId;
          fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8');
        } catch {}
        log.info(`已合并底座 ${parentId} → ${instanceId}${usedByOthers ? '（保留底座）' : ''}`);
        if (!usedByOthers && needBase) {
          try {
            fs.rmSync(path.join(mcDir, 'versions', parentId), { recursive: true, force: true });
            log.info(`已移除临时底座目录：${parentId}`);
          } catch (e) { log.warn('移除底座目录失败：' + e.message); }
        }
      }
    } catch (e) {
      if (/已中止导入/.test(e.message)) throw e;
      log.warn('合并底座失败（不影响启动）：' + e.message);
    }
  }

  // ---------- 2. 解包 overrides ----------
  const ov = info.overridesDir || (info.format === 'modrinth' ? 'overrides' : info.format === 'curseforge' ? (info.overridesDir || 'overrides') : '');
  report({ stage: 'overrides', message: '解包实例文件', percent: 72 });
  if (ov) {
    const prefix = `${ov.replace(/\/+$/, '')}/`;
    let count = 0;
    for (const e of entries) {
      const n = e.entryName.replace(/\\/g, '/');
      if (!n.startsWith(prefix) || e.isDirectory) continue;
      const rel = n.slice(prefix.length);
      const safeRel = safe.safeEntryName(rel);
      if (!safeRel) continue;
      const top = safeRel.split('/')[0];
      if (SKIP_TOP.has(top)) continue; // 启动器数据 / 日志不覆盖
      const dest = safe.safeJoin(instanceDir, safeRel);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, e.getData());
      count += 1;
    }
    log.info(`整合包 overrides 解包 ${count} 个文件 → ${instanceId}`);
  } else {
    // raw 格式：根目录即 .minecraft 内容，直接解到实例目录
    let count = 0;
    for (const e of entries) {
      const n = e.entryName.replace(/\\/g, '/');
      if (e.isDirectory) continue;
      const safeRel = safe.safeEntryName(n);
      if (!safeRel) continue;
      if (SKIP_TOP.has(safeRel.split('/')[0])) continue;
      if (safeRel.endsWith('.json') && safeRel.includes('/versions/')) {
        // 版本 JSON 保留相对结构
      }
      const dest = safe.safeJoin(instanceDir, safeRel);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, e.getData());
      count += 1;
    }
    log.info(`裸目录整合包解包 ${count} 个文件 → ${instanceId}`);
  }

  // ---------- 3. 下载清单文件（Modrinth / MCBBS 直链；CF 由 hooks 提供） ----------
  const dl = info.files || [];
  const todo = dl.filter((f) => (f.downloads && f.downloads.length) || (hooks.resolveCurseforgeFile && f.projectID));
  let done = 0;
  const progress = new Map(); // rel -> 0..1
  let lastEmit = 0;
  const emitProgress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < 180) return;
    lastEmit = now;
    let sum = 0;
    for (const v of progress.values()) sum += Math.min(1, v || 0);
    const pct = 72 + Math.round((sum / Math.max(1, todo.length)) * 24);
    // 找出正在下载的文件，展示 已下载/总大小
    let active = '';
    for (const [rel, frac] of progress) {
      if (frac > 0 && frac < 1) {
        const f = todo.find((x) => String(x.path).endsWith(rel.replace(/^.*?mods\//, 'mods/')));
        const size = f ? f.size : 0;
        if (size) active = ` · ${(frac * size / 1048576).toFixed(1)}/${(size / 1048576).toFixed(1)} MB`;
        break;
      }
    }
    report({ stage: 'files', message: `下载清单文件 ${done}/${todo.length}${active}`, percent: Math.min(96, pct) });
  };
  const signal = hooks.signal || null;
  await net.pool(todo, Math.min(24, Math.max(1, todo.length)), async (f) => {
    if (signal && signal.aborted) { const e = new Error('已取消'); e.aborted = true; throw e; }
    const rel = safe.safeEntryName(f.path);
    if (!rel) return;
    const dest = safe.safeJoin(instanceDir, rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    report({ stage: 'files', message: `下载清单文件 ${done + 1}/${todo.length} · ${path.basename(rel)}`, percent: Math.min(96, 72 + Math.round((done / Math.max(1, todo.length)) * 24)) });
    try {
      if (f.projectID && hooks.resolveCurseforgeFile) {
        const cf = await hooks.resolveCurseforgeFile(f.projectID, f.fileID);
        await netDownloadFirst(cf.urls || [], dest, cf.hashes || {}, f.size || 0, signal, (n) => { progress.set(rel, f.size ? n / f.size : 0); emitProgress(); });
      } else {
        await netDownloadFirst(f.downloads || [], dest, f.hashes || {}, f.size || 0, signal, (n) => { progress.set(rel, f.size ? n / f.size : 0); emitProgress(); });
      }
    } catch (e) {
      if (e && e.aborted) throw e;
      warnings.push(`${path.basename(rel)}：${e.message}`);
      if (f.env && f.env.client === 'unsupported') return;
      if (f.required === false) return;
    }
    done += 1;
    progress.set(rel, 1);
    emitProgress(true);
  });

  try { fs.unlinkSync(importingMarker); } catch {}
  report({ stage: 'done', message: '导入完成', percent: 100 });
  log.info(`整合包导入完成：${instanceId}${warnings.length ? `（${warnings.length} 个警告）` : ''}`);
  return { id: instanceId, dir: instanceDir, warnings };
}

/** 依次尝试多个下载地址（镜像竞速在上层已由 net.download 处理） */
async function netDownloadFirst(urls, dest, hashes, size, signal, onBytes) {
  const errors = [];
  for (const url of urls) {
    try {
      if (signal && signal.aborted) { const e = new Error('已取消'); e.aborted = true; throw e; }
      const big = (size || 0) > 4 * 1024 * 1024;
      await require('./net')[big ? 'downloadLarge' : 'download'](url, dest, {
        expectedSize: size || 0,
        expectedSha1: (hashes && hashes.sha1) || '',
        expectedSha256: (hashes && hashes.sha256) || '',
        expectZip: /\.jar$/i.test(dest),
        retries: 1,
        timeout: 12000,
        idleTimeout: 8000,
        signal,
        onBytes,
      });
      return;
    } catch (e) {
      if (e && e.aborted) throw e;
      errors.push(e.message);
    }
  }
  throw new Error(errors.join('；') || '无可用下载地址');
}

// ---------------------------------------------------------------- 导出
const EXPORT_INCLUDES = ['mods', 'config', 'options.txt', 'resourcepacks', 'shaderpacks', 'defaultconfigs', 'kubejs', 'scripts'];

/**
 * 生成导出计划：列出会被打包的文件与体积，让用户确认。
 * @returns {{files:[{path,size}], totalBytes, loader, loaderVersion, mcVersion}}
 */
function exportPlan(mcDir, instanceId, dirOverride) {
  safe.assertVersionId(instanceId);
  // dirOverride：跨目录实例（PCL/HMCL 隔离实例不在主 mcDir 下），同样在 versions/ 层
  const dir = dirOverride
    ? safe.safeJoin(path.join(String(dirOverride), 'versions'), instanceId)
    : safe.safeJoin(path.join(mcDir, 'versions'), instanceId);
  const files = [];
  let meta = null;
  try {
    meta = versionLib.loadVersionJson(mcDir, instanceId);
  } catch {}

  const add = (rel, abs) => {
    try {
      const st = fs.statSync(abs);
      if (st.isFile()) files.push({ path: rel, size: st.size });
    } catch {}
  };

  for (const name of EXPORT_INCLUDES) {
    const abs = path.join(dir, name);
    if (!fs.existsSync(abs)) continue;
    const st = fs.statSync(abs);
    if (st.isFile()) add(name, abs);
    else walkCollect(abs, name, files, add, 0);
  }

  let loader = '', loaderVersion = '', mcVersion = '';
  if (meta) {
    mcVersion = versionLib.guessMcVersion(instanceId, meta);
    const l = versionLib.loaderOf(instanceId, meta);
    if (l !== '原版') {
      loader = l.toLowerCase();
      const m = String(instanceId).match(/-([\d][^-]*?)(?:-1\.\d+)?$/) || String(instanceId).match(new RegExp(`${escapeRe(mcVersion)}$`));
      loaderVersion = m ? m[1] : '';
      if (loader === 'fabric' || loader === 'quilt') {
        const lm = String(instanceId).match(/^(?:fabric|quilt)-loader-([\d.]+)-/i);
        if (lm) loaderVersion = lm[1];
      }
    }
  }

  return {
    id: instanceId,
    dir, // 实例实际所在目录（跨目录实例也正确）
    files,
    totalBytes: files.reduce((s, f) => s + f.size, 0),
    loader,
    loaderVersion,
    mcVersion,
  };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function walkCollect(dir, rel, files, add, depth) {
  if (depth > 8) return;
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) walkCollect(path.join(dir, e.name), r, files, add, depth + 1);
    else add(r, path.join(dir, e.name));
  }
}

/** 导出为 Modrinth 格式 zip（modrinth.index.json + overrides/） */
async function exportPack(mcDir, instanceId, destZip, onProgress, dirOverride) {
  const plan = exportPlan(mcDir, instanceId, dirOverride);
  const zip = new AdmZip();

  const index = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: instanceId,
    name: instanceId,
    summary: `由 星启 SWUSTMCL 导出`,
    files: plan.files
      .filter((f) => f.path.startsWith('mods/') && f.path.endsWith('.jar'))
      .map((f) => ({
        path: f.path,
        hashes: { sha1: sha1Of(path.join(plan.dir || path.join(mcDir, 'versions', instanceId), f.path)) },
        env: { client: 'required', server: 'required' },
        downloads: [],
        fileSize: f.size,
      })),
    dependencies: {
      ...(plan.mcVersion ? { minecraft: plan.mcVersion } : {}),
      ...(plan.loader === 'fabric' ? { 'fabric-loader': plan.loaderVersion || 'latest' } : {}),
      ...(plan.loader === 'quilt' ? { 'quilt-loader': plan.loaderVersion || 'latest' } : {}),
      ...(plan.loader === 'forge' ? { forge: plan.loaderVersion || '' } : {}),
      ...(plan.loader === 'neoforge' ? { neoforge: plan.loaderVersion || '' } : {}),
    },
  };
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify(index, null, 2), 'utf8'));

  const total = plan.files.length;
  let done = 0;
  for (const f of plan.files) {
    const abs = path.join(plan.dir || path.join(mcDir, 'versions', instanceId), f.path);
    try {
      zip.addLocalFile(abs, `overrides/${path.dirname(f.path)}`.replace(/\/+$/, ''), path.basename(f.path));
    } catch {}
    done += 1;
    if (onProgress && (done % 20 === 0 || done === total)) {
      onProgress({ done, total, percent: Math.round((done / Math.max(1, total)) * 100) });
    }
  }

  await fsp.writeFile(destZip, zip.toBuffer());
  return { file: destZip, count: total, bytes: plan.totalBytes };
}

function sha1Of(file) {
  try {
    return require('crypto').createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return '';
  }
}

module.exports = { inspect, importPack, exportPlan, exportPack, uniqueInstanceId };
