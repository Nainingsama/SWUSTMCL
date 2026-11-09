'use strict';
/**
 * 多账户存储层。
 * 结构（safeStorage 加密）：settings.getSecret('accounts') = { list: [entry], activeId }
 * entry = { uid, type: 'offline'|'msa'|'authlib', name, uuid, payload }
 *   - msa.payload：{ accessToken, refreshToken, expiresAt, skins, xuid, clientId, mode }
 *   - authlib.payload：{ root, accessToken, clientToken, profiles, selected }
 * 兼容：切换账户时把对应 payload 写回旧的 'msa' / 'authlib' secret（启动流程无感知）。
 */
const settingsLib = require('./settings');

function read() {
  const j = settingsLib.getSecret('accounts');
  if (j && Array.isArray(j.list)) return j;
  return { list: [], activeId: '' };
}

function write(store) {
  settingsLib.setSecret('accounts', store);
}

function list() {
  return read().list;
}

function activeId() {
  return read().activeId;
}

function active() {
  const s = read();
  return s.list.find((a) => a.uid === s.activeId) || null;
}

function upsert(entry) {
  const s = read();
  const uid = entry.uid || (entry.type + '-' + (entry.uuid || entry.name) + '-' + Date.now());
  const existing = s.list.findIndex((a) => a.uid === uid);
  if (existing >= 0) s.list[existing] = { ...s.list[existing], ...entry, uid };
  else s.list.push({ ...entry, uid });
  write(s);
  return uid;
}

function remove(uid) {
  const s = read();
  s.list = s.list.filter((a) => a.uid !== uid);
  if (s.activeId === uid) s.activeId = s.list.length ? s.list[0].uid : '';
  write(s);
  return s.activeId || null;
}

function setActive(uid) {
  const s = read();
  if (!s.list.some((a) => a.uid === uid)) return null;
  s.activeId = uid;
  write(s);
  const a = s.list.find((x) => x.uid === uid);
  // 兼容旧启动链路：把激活账户写回对应类型的 secret
  if (a.type === 'msa') settingsLib.setSecret('msa', a.payload);
  if (a.type === 'authlib') settingsLib.setSecret('authlib', a.payload);
  return a;
}

module.exports = { read, list, activeId, active, upsert, remove, setActive };
