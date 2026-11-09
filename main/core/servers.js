'use strict';
/**
 * SWUSTMC 服务器列表：内置校服 + 用户自定义，Minecraft 服务器列表协议（SLP）探测在线状态。
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const { app } = require('electron');

// 默认为空：服务器列表由用户自行添加（后续版本再内置校服）
const DEFAULTS = [];
// 曾内置过的校服参考（后续更新可从这里恢复）：
// { id: 'swust-41000', name: '复原工程', host: 'mc.swustmc.cn', port: 41000, note: '周目：第一周目 · Leaf 1.21.8' }
// { id: 'swust-41005', name: '长期生存服', host: 'mc.swustmc.cn', port: 41005, note: '周目：第一周目 · Velocity 1.7.2-26.3' }
// { id: 'swust-41004', name: '第10周小游戏minigames', host: 'mc.swustmc.cn', port: 41004, note: '周目：第一周目' }

function storePath() {
  return path.join(app.getPath('userData'), 'servers.json');
}

function readUser() {
  try {
    const j = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

function writeUser(list) {
  try {
    fs.writeFileSync(storePath(), JSON.stringify(list, null, 2), 'utf8');
  } catch {}
}

/** 内置条目可被用户覆盖（实例绑定等），用户也可增删自定义条目 */
function list() {
  const user = readUser();
  const removed = new Set(user.filter((s) => s.removed).map((s) => s.id));
  const overrides = new Map(user.filter((s) => !s.removed).map((s) => [s.id, s]));
  const out = DEFAULTS.filter((d) => !removed.has(d.id)).map((d) => ({ ...d, builtin: true, ...(overrides.get(d.id) || {}) }));
  for (const u of user) {
    if (!u.removed && !DEFAULTS.some((d) => d.id === u.id)) out.push({ ...u, builtin: false });
  }
  return out;
}

function saveOne(entry) {
  const e = entry || {};
  const host = String(e.host || '').trim();
  if (!host) throw new Error('缺少服务器地址');
  const port = Math.min(65535, Math.max(1, Number(e.port) || 25565));
  const id = String(e.id || `custom-${Date.now()}`);
  const rec = {
    id,
    name: String(e.name || `${host}:${port}`).slice(0, 40),
    host,
    port,
    note: String(e.note || '').slice(0, 80),
    instanceId: String(e.instanceId || ''),
    removed: false,
  };
  const user = readUser().filter((s) => s.id !== id);
  user.push(rec);
  writeUser(user);
  return rec;
}

function remove(id) {
  const user = readUser().filter((s) => s.id !== id);
  // 内置条目用 removed 标记隐藏
  if (DEFAULTS.some((d) => d.id === id)) user.push({ id, removed: true });
  writeUser(user);
  return true;
}

// ---------------------------------------------------------------- SLP 探测
function writeVarInt(n) {
  const bytes = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function readVarInt(buf, off) {
  let result = 0;
  let shift = 0;
  let byte;
  do {
    if (off >= buf.length) throw new Error('need more');
    byte = buf[off++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
    if (shift > 35) throw new Error('varint too long');
  } while (byte & 0x80);
  return [result, off];
}

function motdText(desc) {
  if (!desc) return '';
  if (typeof desc === 'string') return desc;
  let out = String(desc.text || '');
  for (const e of desc.extra || []) out += typeof e === 'string' ? e : String(e.text || '');
  return out.replace(/§./g, '').trim();
}

/** Minecraft Server List Ping：返回 { online, players, version, motd, latency } */
function ping(host, port, timeoutMs = 4500) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    const sock = net.connect({ host, port: Number(port) || 25565 });
    let buf = Buffer.alloc(0);
    const finish = (result) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve(result);
    };
    sock.setTimeout(timeoutMs, () => finish({ online: false, error: '连接超时' }));
    sock.on('error', (e) => finish({ online: false, error: e.code || e.message }));
    sock.on('connect', () => {
      const hostBuf = Buffer.from(host, 'utf8');
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(Number(port) || 25565);
      const body = Buffer.concat([
        writeVarInt(0x00),
        writeVarInt(767),
        writeVarInt(hostBuf.length),
        hostBuf,
        portBuf,
        writeVarInt(1), // next state = status
      ]);
      sock.write(Buffer.concat([writeVarInt(body.length), body]));
      sock.write(Buffer.concat([writeVarInt(1), writeVarInt(0x00)])); // status request
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      try {
        const [len, off1] = readVarInt(buf, 0);
        if (buf.length < off1 + len) return;
        const [, off2] = readVarInt(buf, off1);
        const [slen, off3] = readVarInt(buf, off2);
        const json = JSON.parse(buf.toString('utf8', off3, off3 + slen));
        finish({
          online: true,
          latency: Date.now() - t0,
          version: (json.version && json.version.name) || '',
          players: {
            online: (json.players && json.players.online) || 0,
            max: (json.players && json.players.max) || 0,
          },
          motd: motdText(json.description),
          favicon: typeof json.favicon === 'string' && json.favicon.startsWith('data:image/') ? json.favicon : '',
        });
      } catch {
        /* 数据未收全，继续等 */
      }
    });
  });
}

module.exports = { DEFAULTS, list, saveOne, remove, ping };
