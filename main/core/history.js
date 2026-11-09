'use strict';
/**
 * 游玩历史：每次游戏会话记录 { id, dir, start, end }，供首页日历展示。
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function file() {
  return path.join(app.getPath('userData'), 'play-history.json');
}

function read() {
  try {
    const a = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

/** 记录一次会话（最多保留 800 条） */
function record(entry) {
  try {
    const a = read();
    a.push({
      id: String(entry.id || ''),
      dir: String(entry.dir || ''),
      start: Number(entry.start) || Date.now(),
      end: Number(entry.end) || Date.now(),
    });
    while (a.length > 800) a.shift();
    fs.writeFileSync(file(), JSON.stringify(a), 'utf8');
  } catch {}
}

module.exports = { read, record };
