'use strict';
/**
 * 实例资源浏览：资源包 / 光影 / 截图。
 * 隔离实例读 versions/<id>/<folder>，共享实例读游戏根目录。
 * 截图用 nativeImage 生成 320px 缩略图（dataURL），避免渲染层直读本地文件。
 */
const fs = require('fs');
const path = require('path');
const { nativeImage } = require('electron');

const safe = require('./safe');
const dirs = require('./dirs');

const KINDS = {
  resourcepacks: { folder: 'resourcepacks', exts: ['.zip'] },
  shaderpacks: { folder: 'shaderpacks', exts: ['.zip'] },
  screenshots: { folder: 'screenshots', exts: ['.png', '.jpg', '.jpeg'] },
};

function gameDirOf(dir, id) {
  const inst = safe.safeJoin(path.join(dir, 'versions'), id);
  return dirs.isIsolatedInstance(inst) ? inst : dir;
}

/**
 * @param {string} dir 游戏根目录
 * @param {string} id 实例名
 * @param {string} kind resourcepacks|shaderpacks|screenshots
 * @param {boolean} withThumbs 是否生成截图缩略图
 */
function list(dir, id, kind, withThumbs = true) {
  const spec = KINDS[kind];
  if (!spec) throw new Error('未知资源类型');
  const root = gameDirOf(dir, id);
  const folder = path.join(root, spec.folder);
  let names = [];
  try { names = fs.readdirSync(folder); } catch { return { folder, items: [], root }; }

  const items = [];
  for (const n of names) {
    const fp = path.join(folder, n);
    let st;
    try { st = fs.statSync(fp); } catch { continue; }
    if (st.isDirectory()) {
      items.push({ name: n, path: fp, size: 0, mtime: st.mtimeMs, dir: true });
      continue;
    }
    const ext = path.extname(n).toLowerCase();
    if (spec.exts.length && !spec.exts.includes(ext)) continue;
    const it = { name: n, path: fp, size: st.size, mtime: st.mtimeMs, dir: false };
    if (kind === 'screenshots' && withThumbs) {
      try {
        const img = nativeImage.createFromPath(fp);
        if (img && !img.isEmpty()) {
          const s = img.getSize();
          if (s.width > 0) {
            const w = 320;
            const h = Math.max(1, Math.round(s.height * (w / s.width)));
            it.thumb = img.resize({ width: w, height: h, quality: 'good' }).toDataURL();
          }
        }
      } catch {}
    }
    items.push(it);
  }
  return { folder, items, root };
}

const TRASHABLE = ['resourcepacks', 'shaderpacks', 'screenshots'];

/** 校验待删除文件确实位于某个资源目录内，避免误删 */
function assertTrashable(file) {
  const p = path.resolve(String(file || ''));
  const parts = p.split(path.sep).map((x) => x.toLowerCase());
  if (!TRASHABLE.some((d) => parts.includes(d))) throw new Error('该文件不在资源目录内，拒绝删除');
  return p;
}

module.exports = { list, assertTrashable, KINDS };
