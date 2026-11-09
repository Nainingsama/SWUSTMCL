'use strict';
/**
 * 存档扫描。兼容三种存放位置：
 *   1) <游戏目录>/saves                  —— 全局存档
 *   2) <游戏目录>/versions/<id>/saves    —— 版本隔离存档（PCL/HMCL 常见）
 *   3) <实例目录>/saves                  —— 部分启动器的实例根目录
 * 只读 level.dat + icon.png + 目录体积，绝不触碰 region/ 区块文件。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const nbt = require('./nbt');

const MAX_ICON_BYTES = 256 * 1024;

async function listDirs(p) {
  try {
    const ents = await fsp.readdir(p, { withFileTypes: true });
    return ents.filter((e) => e.isDirectory());
  } catch {
    return [];
  }
}

/** 递归统计目录体积；await 让出事件循环，避免阻塞主进程 */
async function dirSize(dir, depth = 0) {
  if (depth > 6) return 0;
  let total = 0;
  let ents = [];
  try {
    ents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += await dirSize(full, depth + 1);
      else if (e.isFile()) total += (await fsp.stat(full)).size;
    } catch {}
  }
  return total;
}

async function readIcon(saveDir) {
  const iconPath = path.join(saveDir, 'icon.png');
  try {
    const st = await fsp.stat(iconPath);
    if (!st.isFile() || st.size > MAX_ICON_BYTES) return null;
    const buf = await fsp.readFile(iconPath);
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

async function readSave(saveDir, ctx) {
  let info = null;
  let broken = false;
  try {
    const buf = await fsp.readFile(path.join(saveDir, 'level.dat'));
    info = nbt.summarize(buf);
  } catch {
    broken = true;
  }

  let mtime = 0;
  try {
    mtime = (await fsp.stat(path.join(saveDir, 'level.dat'))).mtimeMs;
  } catch {
    try {
      mtime = (await fsp.stat(saveDir)).mtimeMs;
    } catch {}
  }

  const [icon, size] = await Promise.all([readIcon(saveDir), dirSize(saveDir)]);
  const folderName = path.basename(saveDir);

  return {
    path: saveDir,
    folderName,
    name: (info && info.levelName) || folderName,
    version: (info && info.version) || '',
    gameType: (info && info.gameType) || '',
    difficulty: (info && info.difficulty) || '',
    hardcore: Boolean(info && info.hardcore),
    wasModded: Boolean(info && info.wasModded),
    seed: info ? info.seed : null,
    lastPlayed: (info && info.lastPlayed) || mtime,
    size,
    icon,
    broken,
    dir: ctx.dir,
    dirName: ctx.dirName,
    instanceId: ctx.instanceId || null,
  };
}

/**
 * 扫描多个游戏目录下的所有存档
 * @param {Array<{path:string,name:string}>} dirs
 * @param {(done:number,total:number)=>void} [onProgress]
 */
async function scan(dirs, onProgress) {
  const jobs = [];
  for (const dir of dirs) {
    if (!dir.path || !fs.existsSync(dir.path)) continue;

    for (const ent of await listDirs(path.join(dir.path, 'saves'))) {
      jobs.push({ saveDir: path.join(dir.path, 'saves', ent.name), ctx: { dir: dir.path, dirName: dir.name } });
    }

    const versionsDir = path.join(dir.path, 'versions');
    for (const inst of await listDirs(versionsDir)) {
      const instSaves = path.join(versionsDir, inst.name, 'saves');
      if (!fs.existsSync(instSaves)) continue;
      for (const ent of await listDirs(instSaves)) {
        jobs.push({
          saveDir: path.join(instSaves, ent.name),
          ctx: { dir: dir.path, dirName: dir.name, instanceId: inst.name },
        });
      }
    }
  }

  const results = [];
  let done = 0;
  const queue = jobs.slice();
  const concurrency = 3;
  const worker = async () => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      try {
        results.push(await readSave(job.saveDir, job.ctx));
      } catch (e) {
        results.push({
          path: job.saveDir,
          folderName: path.basename(job.saveDir),
          name: path.basename(job.saveDir),
          broken: true,
          error: e.message,
          size: 0,
          lastPlayed: 0,
          icon: null,
          ...job.ctx,
        });
      }
      done += 1;
      if (onProgress) onProgress(done, jobs.length);
    }
  };
  await Promise.all(new Array(Math.min(concurrency, queue.length)).fill(0).map(worker));

  results.sort((a, b) => b.lastPlayed - a.lastPlayed);
  return results;
}

module.exports = { scan, dirSize };
