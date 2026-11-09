'use strict';
/**
 * 自研 NBT 读取器（只解析，不写回）。
 *
 * 用途：读存档 level.dat 的世界名 / 版本 / 模式 / 最后游玩时间。
 * 原则：绝不加载任何区块数据（region 文件根本不会被打开），保证扫描极速。
 *
 * 支持 TAG 1-12 全部类型：
 *   1 Byte 2 Short 3 Int 4 Long 5 Float 6 Double
 *   7 ByteArray 8 String 9 List 10 Compound 11 IntArray 12 LongArray
 */
const zlib = require('zlib');

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  need(n) {
    if (this.pos + n > this.buf.length) throw new Error('NBT 数据越界');
  }
  u1() { this.need(1); return this.buf.readUInt8(this.pos++); }
  i1() { this.need(1); return this.buf.readInt8(this.pos++); }
  i2() { this.need(2); const v = this.buf.readInt16BE(this.pos); this.pos += 2; return v; }
  u2() { this.need(2); const v = this.buf.readUInt16BE(this.pos); this.pos += 2; return v; }
  i4() { this.need(4); const v = this.buf.readInt32BE(this.pos); this.pos += 4; return v; }
  i8() { this.need(8); const v = this.buf.readBigInt64BE(this.pos); this.pos += 8; return Number(v); }
  f4() { this.need(4); const v = this.buf.readFloatBE(this.pos); this.pos += 4; return v; }
  f8() { this.need(8); const v = this.buf.readDoubleBE(this.pos); this.pos += 8; return v; }
  str() {
    const len = this.u2();
    this.need(len);
    const s = this.buf.toString('utf8', this.pos, this.pos + len);
    this.pos += len;
    return s;
  }
}

/** long 数组/列表元素转 Number；超出安全整数时保留低 53 位（UI 只展示用） */
function longToNumber(v) {
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  return Number.isSafeInteger(n) ? n : n;
}

function readPayload(r, type, depth) {
  if (depth > 64) throw new Error('NBT 嵌套过深');
  switch (type) {
    case 1: return r.i1();
    case 2: return r.i2();
    case 3: return r.i4();
    case 4: return r.i8();
    case 5: return r.f4();
    case 6: return r.f8();
    case 7: {
      const n = r.i4();
      r.need(n);
      r.pos += n; // 字节数组只记长度，不复制内容
      return { __bytes: n };
    }
    case 8: return r.str();
    case 9: {
      const itemType = r.u1();
      const n = r.i4();
      if (n < 0) throw new Error('NBT 列表长度为负');
      const arr = [];
      const cap = Math.min(n, 512); // 大列表不展开，避免读档卡顿
      for (let i = 0; i < n; i++) {
        const v = readPayload(r, itemType, depth + 1);
        if (i < cap) arr.push(v);
      }
      return arr;
    }
    case 10: {
      const obj = {};
      for (;;) {
        const t = r.u1();
        if (t === 0) break;
        const name = r.str();
        obj[name] = readPayload(r, t, depth + 1);
      }
      return obj;
    }
    case 11: {
      const n = r.i4();
      r.need(n * 4);
      r.pos += n * 4;
      return { __ints: n };
    }
    case 12: {
      const n = r.i4();
      r.need(n * 8);
      r.pos += n * 8;
      return { __longs: n };
    }
    default:
      throw new Error(`未知的 NBT 类型 ${type}`);
  }
}

/**
 * 解析 level.dat（gzip 压缩的 NBT）。自动识别 gzip 与未压缩两种形态。
 * 返回根 Compound 的对象。
 */
function readLevelDat(fileBuffer) {
  let buf = fileBuffer;
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  else if (buf.length > 2 && buf[0] === 0x78) {
    // zlib 流（78 01 / 78 9c / 78 da 都是合法压缩级别），失败则按原始数据解析
    try {
      buf = zlib.inflateSync(buf);
    } catch {}
  }
  const r = new Reader(buf);
  const type = r.u1();
  if (type !== 10) throw new Error('level.dat 根标签不是 Compound');
  r.str(); // 根标签名，通常为空
  return readPayload(r, 10, 0);
}

const GAME_MODE = { 0: '生存', 1: '创造', 2: '冒险', 3: '旁观' };
const DIFFICULTY_NUM = { 0: '和平', 1: '简单', 2: '普通', 3: '困难' };
const DIFFICULTY_STR = { peaceful: '和平', easy: '简单', normal: '普通', hard: '困难' };

/** 去掉 Minecraft 的 § 格式码（§6、§l、§x§f§f… 等） */
function stripFormatting(s) {
  if (!s) return s;
  return String(s)
    .replace(/§x(§[0-9a-fA-F]){6}/g, '')
    .replace(/§[0-9a-fk-orA-FK-OR]/g, '')
    .trim();
}

/** 从 level.dat 提炼 UI 需要的字段 */
function summarize(buf) {
  const root = readLevelDat(buf);
  const d = root.Data || root;
  const version = d.Version && d.Version.Name ? String(d.Version.Name) : '';
  // 1.21.2+ 把难度挪进了 difficulty_settings.difficulty（字符串）；
  // 旧版本是 Data.Difficulty（数字）。两处都看。
  const ds = d.difficulty_settings || d.DifficultySettings || {};
  const difficulty =
    DIFFICULTY_STR[ds.difficulty] || DIFFICULTY_NUM[Number(d.Difficulty)] || '未知';
  const seedRaw = (d.WorldGenSettings && d.WorldGenSettings.seed) ?? d.RandomSeed ?? null;

  return {
    levelName: stripFormatting(d.LevelName) || '',
    version,
    snapshot: Boolean(d.Version && d.Version.Snapshot),
    lastPlayed: Number(d.LastPlayed) || 0,
    gameType: GAME_MODE[Number(d.GameType)] || '未知',
    difficulty,
    hardcore: Boolean(Number(ds.hardcore ?? d.hardcore ?? 0)),
    seed: seedRaw === null ? null : longToNumber(seedRaw),
    dataVersion: Number(d.DataVersion) || 0,
    allowCommands: Boolean(Number(d.allowCommands || 0)),
    wasModded: Boolean(Number(d.WasModded || 0)),
  };
}

module.exports = { readLevelDat, summarize, stripFormatting, longToNumber };
