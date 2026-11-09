'use strict';
/**
 * GPU 兼容兜底 + Windows 显卡偏好。
 *
 * 一、兜底：部分机器（驱动异常、安全软件拦截沙箱）会让 Chromium 的 GPU 进程
 * 一启动就崩溃，表现为 "GPU process isn't usable. Goodbye." 直接退出。
 * 两级处理（main.js 调用）：
 *   1. app.on('child-process-gone') 里发现 GPU 进程异常退出 → 写入兼容标记
 *      （settings.gpuFallback）并带 --no-sandbox / --disable-gpu-sandbox 重启；
 *   2. 下次启动读到标记 → 直接以兼容模式启动，并在标记存在期间禁用硬件加速
 *      （app.disableHardwareAcceleration）。
 *
 * 二、偏好：Windows「按应用设置图形性能」在
 *   HKCU\Software\Microsoft\DirectX\UserGpuPreferences
 * 值名 = exe 绝对路径，值 = "GpuPreference=2;"。注意 Minecraft 由 javaw.exe
 * 启动，值名必须写 javaw 的路径，写 java.exe 不生效。
 */
const path = require('path');
const { execFile } = require('child_process');

const REG_KEY = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences';
const MODES = { high: 'GpuPreference=2;', power: 'GpuPreference=1;', auto: null };

function supported() {
  return process.platform === 'win32';
}

function normalizeExe(p) {
  const raw = String(p || '').trim().replace(/^"+|"+$/g, '');
  if (!raw) return '';
  return path.resolve(raw).replace(/\//g, '\\');
}

function toJavaw(p) {
  const exe = normalizeExe(p);
  return /\\java\.exe$/i.test(exe) ? exe.replace(/\\java\.exe$/i, '\\javaw.exe') : exe;
}

function decode(buf) {
  if (!buf || !buf.length) return '';
  try {
    return new TextDecoder('gbk').decode(buf); // reg.exe 输出走系统 ANSI 代码页
  } catch {
    return Buffer.from(buf).toString('utf8');
  }
}

function friendly(err) {
  const sig = `${(err && err.code) || ''} ${(err && err.message) || ''}`;
  if (/EACCES|EPERM/.test(sig)) return '被安全软件或系统策略拦截，无法调用 reg.exe';
  if (/ENOENT/.test(sig)) return '系统里找不到 reg.exe';
  return (err && err.message) || '调用 reg.exe 失败';
}

function run(args) {
  return new Promise((resolve) => {
    const done = (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true, stdout: decode(stdout), stderr: '' });
      resolve({ ok: false, stdout: '', stderr: decode(stderr).trim() || friendly(err) });
    };
    try {
      execFile('reg.exe', args, { windowsHide: true, encoding: 'buffer' }, done);
    } catch (e) {
      resolve({ ok: false, stdout: '', stderr: friendly(e) });
    }
  });
}

async function readAll() {
  if (!supported()) return new Map();
  const r = await run(['query', REG_KEY]);
  const map = new Map();
  if (!r.ok) return map;
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/^\s{4}(.*?)\s{4}(REG_[A-Z_]+)\s{4}(.*)$/);
    if (m) map.set(m[1].toLowerCase(), m[3].trim());
  }
  return map;
}

async function setPreference(exePath, mode) {
  if (!supported()) return { ok: false, error: '仅 Windows 支持显卡偏好' };
  if (!(mode in MODES)) return { ok: false, error: `未知的显卡模式：${mode}` };
  const exe = toJavaw(exePath);
  if (!exe) return { ok: false, error: 'Java 路径为空' };

  if (MODES[mode] === null) {
    const current = await readAll();
    if (!current.has(exe.toLowerCase())) return { ok: true, exe, skipped: true };
    const r = await run(['delete', REG_KEY, '/v', exe, '/f']);
    return { ok: r.ok, exe, error: r.ok ? undefined : r.stderr || '注册表删除失败' };
  }
  const r = await run(['add', REG_KEY, '/v', exe, '/t', 'REG_SZ', '/d', MODES[mode], '/f']);
  return { ok: r.ok, exe, error: r.ok ? undefined : r.stderr || '注册表写入失败' };
}

async function applyAll(exePaths, mode) {
  if (!supported()) return { supported: false, mode, applied: [], failed: [] };
  const unique = Array.from(new Set((exePaths || []).filter(Boolean).map(toJavaw)));
  const applied = [];
  const failed = [];
  for (const exe of unique) {
    try {
      const r = await setPreference(exe, mode);
      if (r.ok) applied.push({ exe });
      else failed.push({ exe, error: r.error });
    } catch (e) {
      failed.push({ exe, error: friendly(e) });
    }
  }
  return { supported: true, mode, applied, failed };
}

module.exports = { REG_KEY, MODES, supported, friendly, normalizeExe, toJavaw, readAll, setPreference, applyAll };
