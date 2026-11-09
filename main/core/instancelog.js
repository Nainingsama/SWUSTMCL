'use strict';
/**
 * 每实例独立日志：userData/logs/instances/<实例名>.log
 * 不同实例的日志分开记录，互不串行；单文件超过 2MB 自动截断保留后半。
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MAX_BYTES = 2 * 1024 * 1024;

function dir() {
  return path.join(app.getPath('userData'), 'logs', 'instances');
}

function safeName(id) {
  return String(id || 'unknown').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 80) || 'unknown';
}

function fileOf(id) {
  return path.join(dir(), safeName(id) + '.log');
}

function append(id, line) {
  const text = String(line || '').replace(/\s+$/, '');
  if (!text) return;
  try {
    fs.mkdirSync(dir(), { recursive: true });
    const f = fileOf(id);
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    fs.appendFileSync(f, `[${t}] ${text}\n`, 'utf8');
    let size = 0;
    try { size = fs.statSync(f).size; } catch {}
    if (size > MAX_BYTES) {
      const tail = fs.readFileSync(f, 'utf8').slice(-Math.floor(MAX_BYTES / 2));
      fs.writeFileSync(f, tail, 'utf8');
    }
  } catch {}
}

/** 读取某实例日志尾部（默认最后 500 行） */
function tail(id, lines = 500) {
  const f = fileOf(id);
  try {
    const all = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    return { file: f, lines: all.slice(-lines), exists: true };
  } catch {
    return { file: f, lines: [], exists: false };
  }
}

function clear(id) {
  try { fs.unlinkSync(fileOf(id)); return true; } catch { return false; }
}

module.exports = { append, tail, clear, fileOf };
