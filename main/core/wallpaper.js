'use strict';
/**
 * 壁纸。
 *
 * 用户导入的图片一律复制到 userData/wallpapers/，渲染层通过自定义协议
 * smcl-wall://local/<文件名> 读取。不直接放 file: URL 的原因：
 *   - img-src 放开 file: 等于允许渲染层探测磁盘任意图片；
 *   - 自定义协议只认「本目录 + 本模块生成的文件名」，穿越在校验阶段即被挡掉。
 * 还包含主题取色：从壁纸提取主色生成整套配色，纯灰图回落校徽蓝。
 */
const fs = require('fs');
const path = require('path');
const { app, dialog, protocol, net, nativeImage } = require('electron');
const { pathToFileURL } = require('url');

const SCHEME = 'smcl-wall';
const HOST = 'local';
const MAX_BYTES = 32 * 1024 * 1024;
const NAME_RE = /^wall-[0-9]{10,16}\.(png|jpg|webp|gif|bmp|avif)$/;

function root() {
  return path.join(app.getPath('userData'), 'wallpapers');
}

function ensureDir() {
  const dir = root();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 只接受本模块自己生成的文件名，天然挡掉 .. 与路径分隔符 */
function isManaged(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

function exists(name) {
  if (!isManaged(name)) return false;
  try {
    return fs.statSync(path.join(root(), name)).isFile();
  } catch {
    return false;
  }
}

function urlFor(name) {
  return isManaged(name) ? `${SCHEME}://${HOST}/${name}` : '';
}

/** 读前 16 字节判真实类型，防止改扩展名的非图片文件混入 */
function sniff(file) {
  let head;
  try {
    const fd = fs.openSync(file, 'r');
    head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    fs.closeSync(fd);
  } catch {
    return '';
  }
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg';
  if (head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (head.toString('ascii', 0, 3) === 'GIF') return 'gif';
  if (head[0] === 0x42 && head[1] === 0x4d) return 'bmp';
  if (head.toString('ascii', 4, 8) === 'ftyp') return 'avif';
  return '';
}

/** 删掉除 keep（字符串或数组）之外的历史壁纸，避免 userData 越堆越大 */
function prune(keep) {
  const keepArr = [].concat(keep || []).filter(Boolean);
  let removed = 0;
  let names = [];
  try {
    names = fs.readdirSync(root());
  } catch {
    return 0;
  }
  for (const name of names) {
    if (keepArr.includes(name)) continue;
    if (!/^wall-[0-9]{10,16}\.[a-z]+$/.test(name)) continue;
    try {
      fs.unlinkSync(path.join(root(), name));
      removed += 1;
    } catch {}
  }
  return removed;
}

function importFile(src, keepList) {
  const file = path.resolve(String(src || ''));
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new Error('图片不存在或无法读取');
  }
  if (!stat.isFile()) throw new Error('请选择一张图片');
  if (stat.size > MAX_BYTES) throw new Error(`图片过大（${(stat.size / 1024 / 1024).toFixed(1)} MB），上限 32 MB`);
  if (stat.size < 128) throw new Error('文件内容异常，可能不是图片');

  const kind = sniff(file);
  if (!kind) throw new Error('无法识别的图片格式，请使用 PNG / JPG / WebP / GIF / BMP');

  const dir = ensureDir();
  const name = `wall-${Date.now()}.${kind}`;
  const dest = path.join(dir, name);
  const tmp = `${dest}.part`;
  try {
    fs.copyFileSync(file, tmp);
    fs.renameSync(tmp, dest);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw new Error(`复制图片失败：${e.message}`);
  }
  const removed = prune([name].concat(keepList || []));
  return { name, url: urlFor(name), size: stat.size, removed };
}

async function pick(parent, keepList) {
  const r = await dialog.showOpenDialog(parent, {
    title: '选择背景图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return importFile(r.filePaths[0], keepList);
}

function clearAll() {
  return prune('');
}

// ------------------------------------------------------------------ 取色
/**
 * 轻量取色：缩到 48×48，HSL 过滤近黑/近白/灰像素，色相做圆周平均
 * （直接算术平均会让红与紫混成品红），权重 = 饱和度 × 中间明度接近度。
 * 纯灰图没有任何有效像素 → 返回 null → 上层回落校徽蓝。
 */
function hslToHex(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const seg = Math.floor(hue / 60) % 6;
  const rgb = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ][seg];
  return `#${rgb.map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('')}`;
}

function rgbaOf(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function sample(name) {
  if (!exists(name)) return null;
  let img;
  try {
    img = nativeImage.createFromPath(path.join(root(), name));
  } catch {
    return null;
  }
  if (!img || img.isEmpty()) return null;
  const { width, height } = img.getSize();
  if (!width || !height) return null;
  const small = img.resize({ width: 48, height: 48, quality: 'good' });
  const bmp = small.getBitmap(); // BGRA
  if (!bmp || bmp.length < 4) return null;

  let cx = 0, sy = 0, weight = 0, satSum = 0, satN = 0;
  let lumSum = 0, lumN = 0;
  for (let i = 0; i + 3 < bmp.length; i += 4) {
    const b = bmp[i] / 255, g = bmp[i + 1] / 255, r = bmp[i + 2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    lumSum += l; lumN += 1;
    if (d < 0.02) continue; // 灰色对色相没有信息量
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (l < 0.12 || l > 0.94) continue;
    if (s < 0.1) continue;
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    const rad = (h * Math.PI) / 180;
    const w = s * (1 - Math.abs(l - 0.5) * 1.1);
    cx += Math.cos(rad) * w;
    sy += Math.sin(rad) * w;
    weight += w;
    satSum += s;
    satN += 1;
  }
  const lum = lumN ? lumSum / lumN : null;
  if (!satN || weight < 0.5) return { h: null, s: null, lum }; // 纯灰 / 近灰图：色相回落，但亮度可用
  const hue = (Math.atan2(sy, cx) * 180) / Math.PI;
  const sat = Math.min(0.78, Math.max(0.44, (satSum / satN) * 1.35));
  return { h: (hue + 360) % 360, s: sat, lum };
}

/**
 * 生成整套主题色。深色界面用更高明度保证对比度。
 * sampled=false 表示取色失败（含纯灰图），h/s 用校徽蓝的色相。
 */
function theme(name) {
  const smp = sample(name);
  const base = smp && smp.h != null ? smp : null;
  const h = base ? base.h : 214;
  const s = base ? base.s : 0.68;
  const lum = smp && smp.lum != null ? Math.round(smp.lum * 100) / 100 : null;
  const darkBase = hslToHex(h, s, 0.6);
  const darkBase2 = hslToHex(h, s, 0.73);
  const lightBase = hslToHex(h, s, 0.42);
  const lightBase2 = hslToHex(h, s, 0.53);
  return {
    sampled: Boolean(base),
    lum,
    hue: Math.round(h),
    sat: Math.round(s * 100) / 100,
    dark: { base: darkBase, base2: darkBase2, soft: rgbaOf(darkBase, 0.18) },
    light: { base: lightBase, base2: lightBase2, soft: rgbaOf(lightBase, 0.13) },
  };
}

// ------------------------------------------------------------------ 协议
function registerScheme() {
  if (!protocol || typeof protocol.registerSchemesAsPrivileged !== 'function') return;
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false, bypassCSP: false } },
  ]);
}

function registerHandler() {
  if (!protocol || typeof protocol.handle !== 'function') return;
  protocol.handle(SCHEME, async (req) => {
    try {
      const u = new URL(req.url);
      const name = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
      // 白名单：host 必须是 local，文件名必须命中本模块的命名规则
      if (u.host !== HOST || !isManaged(name)) {
        return new Response('forbidden', { status: 403 });
      }
      const file = path.join(root(), name);
      if (!fs.existsSync(file)) return new Response('not found', { status: 404 });
      return net.fetch(pathToFileURL(file).href);
    } catch (e) {
      return new Response(`error: ${e.message}`, { status: 400 });
    }
  });
}

module.exports = { SCHEME, MAX_BYTES, root, ensureDir, isManaged, exists, urlFor, importFile, pick, clearAll, prune, theme, registerScheme, registerHandler };
