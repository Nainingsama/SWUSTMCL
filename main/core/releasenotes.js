'use strict';
/**
 * 更新日志读取：解析 CHANGELOG.md，按语义化版本取最新一段，供首页公告卡片使用。
 * 打包后 CHANGELOG.md 位于 resources/app/CHANGELOG.md。
 */
const fs = require('fs');
const path = require('path');

function candidates() {
  const list = [];
  try { list.push(path.join(__dirname, '..', '..', 'CHANGELOG.md')); } catch {}
  try {
    if (process.resourcesPath) list.push(path.join(process.resourcesPath, 'app', 'CHANGELOG.md'));
  } catch {}
  return list;
}

function parse(md) {
  const all = [];
  const parts = md.split(/^## \[/m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const head = nl >= 0 ? part.slice(0, nl) : part;
    const body = nl >= 0 ? part.slice(nl + 1) : '';
    const hm = head.match(/^([^\]]+)\](?:\s*-\s*(.*))?$/);
    if (!hm) continue;
    const version = String(hm[1] || '').trim();
    if (!version || /^unreleased$/i.test(version)) continue;
    const lines = body
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter((x) => /^[-*]\s+/.test(x));
    all.push({
      version,
      date: String(hm[2] || '').trim(),
      items: lines.slice(0, 30).map((x) => x.replace(/^[-*]\s+/, '').replace(/\*\*/g, '')),
    });
  }
  return all;
}

function sortByVersionDesc(list) {
  const key = (v) => String(v).split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  return list.slice().sort((a, b) => {
    const ka = key(b.version);
    const kb = key(a.version);
    for (let i = 0; i < 4; i++) if ((ka[i] || 0) !== (kb[i] || 0)) return (ka[i] || 0) - (kb[i] || 0);
    return 0;
  });
}

function latest() {
  for (const file of candidates()) {
    try {
      const md = fs.readFileSync(file, 'utf8');
      const all = sortByVersionDesc(parse(md));
      if (!all.length) continue;
      const top = all[0];
      return { ok: true, version: top.version, date: top.date, items: top.items };
    } catch {}
  }
  return { ok: false, version: '', date: '', items: [] };
}

module.exports = { latest, parse };
