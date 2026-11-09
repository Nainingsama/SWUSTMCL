'use strict';
/**
 * 全局日志：主进程与游戏进程的输出统一进一个环形缓冲，
 * 渲染层底部的日志抽屉从这里取历史，再通过事件实时增量。
 */
const { EventEmitter } = require('events');

const MAX_LINES = 2000;
const bus = new EventEmitter();
bus.setMaxListeners(50);

const lines = []; // { t: 时间戳, level: 'info'|'warn'|'error'|'game'|'game-err', text }

function push(level, text) {
  const line = { t: Date.now(), level, text: String(text).replace(/\s+$/, '') };
  lines.push(line);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  bus.emit('line', line);
  // 主进程自己的输出也带到控制台，方便打包后排查
  const tag = { info: 'log', warn: 'warn', error: 'error', game: 'game', 'game-err': 'game' }[level] || 'log';
  if (level === 'game' || level === 'game-err') return; // 游戏日志量大，不进控制台
  console[tag](`[${level}] ${line.text}`);
}

function info(msg) { push('info', msg); }
function warn(msg) { push('warn', msg); }
function error(msg) { push('error', msg); }
function game(text, isError) { push(isError ? 'game-err' : 'game', text); }

function recent(n = 300) {
  return lines.slice(-n);
}

function clear() {
  lines.length = 0;
  bus.emit('cleared');
}

function onLine(cb) {
  bus.on('line', cb);
  return () => bus.removeListener('line', cb);
}

function onCleared(cb) {
  bus.on('cleared', cb);
  return () => bus.removeListener('cleared', cb);
}

module.exports = { info, warn, error, game, recent, clear, onLine, onCleared };
