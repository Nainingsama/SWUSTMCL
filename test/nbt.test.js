'use strict';
/**
 * NBT 解析器测试：手工构造 level.dat 二进制（gzip），覆盖 TAG 1-12、
 * 嵌套、1.21.2 difficulty_settings、§ 格式码剥离、大列表截断。
 */
const zlib = require('zlib');
const { test, assert, summary } = require('./lib');

// 让 nbt.js 不依赖 electron：readLevelDat/summarize 不引用 electron，直接 require
const nbt = require('../main/core/nbt');

// ------------------------------------------------ 手写 NBT 编码器（测试专用）
class Writer {
  constructor() { this.buf = []; }
  u1(v) { this.buf.push(v & 0xff); return this; }
  i1(v) { this.buf.push(v < 0 ? v + 256 : v); return this; }
  i2(v) { this.buf.push((v >> 8) & 0xff, v & 0xff); return this; }
  i4(v) { this.buf.push((v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff); return this; }
  i8(v) {
    const big = BigInt(v);
    for (let shift = 56; shift >= 0; shift -= 8) this.buf.push(Number((big >> BigInt(shift)) & 0xffn));
    return this;
  }
  f4(v) { const b = Buffer.alloc(4); b.writeFloatBE(v); this.buf.push(...b); return this; }
  f8(v) { const b = Buffer.alloc(8); b.writeDoubleBE(v); this.buf.push(...b); return this; }
  str(s) {
    const b = Buffer.from(String(s), 'utf8');
    this.i2(b.length);
    this.buf.push(...b);
    return this;
  }
  bytes(arr) { this.i4(arr.length); this.buf.push(...arr); return this; }
  payload(type, v) {
    switch (type) {
      case 1: return this.i1(v);
      case 2: return this.i2(v);
      case 3: return this.i4(v);
      case 4: return this.i8(v);
      case 5: return this.f4(v);
      case 6: return this.f8(v);
      case 7: return this.bytes(v);
      case 8: return this.str(v);
      case 9: {
        this.u1(v.itemType);
        this.i4(v.items.length);
        for (const it of v.items) this.payload(v.itemType, it);
        return this;
      }
      case 10: {
        for (const [name, tv, val] of v) { this.u1(tv).str(name).payload(tv, val); }
        return this.u1(0);
      }
      case 11: {
        this.i4(v.length);
        for (const x of v) this.i4(x);
        return this;
      }
      case 12: {
        this.i4(v.length);
        for (const x of v) this.i8(x);
        return this;
      }
      default: throw new Error('bad type');
    }
  }
  toBuffer() { return Buffer.from(this.buf); }
}

function makeLevelDat(dataFields, rootName = '') {
  const w = new Writer();
  w.u1(10).str(rootName).payload(10, dataFields);
  return zlib.gzipSync(w.toBuffer());
}

async function run() {
  console.log('—— NBT 解析器');

  await test('TAG 1-12 全类型解析', () => {
    const buf = makeLevelDat([
      ['Byte', 1, -5],
      ['Short', 2, -3000],
      ['Int', 3, 123456],
      ['Long', 4, 9007199254740991],
      ['Float', 5, 3.5],
      ['Double', 6, 2.718281828],
      ['ByteArray', 7, [1, 2, 3, 4]],
      ['Text', 8, '你好世界'],
      ['List', 9, { itemType: 3, items: [10, 20, 30] }],
      ['Nested', 10, [['Inner', 8, 'deep']]],
      ['Ints', 11, [1, 2, 3]],
      ['Longs', 12, [111, 222]],
    ]);
    const root = nbt.readLevelDat(buf);
    assert.equal(root.Byte, -5, 'byte');
    assert.equal(root.Short, -3000, 'short');
    assert.equal(root.Int, 123456, 'int');
    assert.equal(root.Long, 9007199254740991, 'long');
    assert.equal(root.Float, 3.5, 'float');
    assert.ok(Math.abs(root.Double - 2.718281828) < 1e-9, 'double');
    assert.deepEqual(root.ByteArray, { __bytes: 4 }, 'bytearray 只记长度');
    assert.equal(root.Text, '你好世界', 'utf8 string');
    assert.deepEqual(root.List, [10, 20, 30], 'list');
    assert.equal(root.Nested.Inner, 'deep', 'nested compound');
    assert.deepEqual(root.Ints, { __ints: 3 }, 'intarray');
    assert.deepEqual(root.Longs, { __longs: 2 }, 'longarray');
  });

  await test('level.dat 摘要（旧版数字难度）', () => {
    const buf = makeLevelDat([
      ['LevelName', 8, '§a§l绿色§r世界'],
      ['LastPlayed', 4, 1700000000000 > 2 ** 31 ? 1700000000 : 1700000000], // 秒级演示
      ['GameType', 3, 1],
      ['Difficulty', 3, 3],
      ['hardcore', 1, 0],
      ['DataVersion', 3, 4189],
      ['allowCommands', 1, 1],
      ['WasModded', 1, 1],
      ['Version', 10, [['Name', 8, '1.21.2'], ['Snapshot', 1, 0]]],
      ['RandomSeed', 4, 12345],
    ]);
    const s = nbt.summarize(buf);
    assert.equal(s.levelName, '绿色世界', '§ 格式码剥离');
    assert.equal(s.version, '1.21.2');
    assert.equal(s.gameType, '创造');
    assert.equal(s.difficulty, '困难');
    assert.equal(s.dataVersion, 4189);
    assert.equal(s.allowCommands, true);
    assert.equal(s.wasModded, true);
  });

  await test('1.21.2+ difficulty_settings.difficulty 字符串', () => {
    const buf = makeLevelDat([
      ['LevelName', 8, '新结构存档'],
      ['difficulty_settings', 10, [['difficulty', 8, 'peaceful'], ['hardcore', 1, 0]]],
      ['Version', 10, [['Name', 8, '1.21.4']]],
    ]);
    const s = nbt.summarize(buf);
    assert.equal(s.difficulty, '和平', '字符串难度');
    assert.equal(s.version, '1.21.4');
    assert.equal(s.hardcore, false);
  });

  await test('WorldGenSettings.seed 与 §x 嵌套格式码', () => {
    const buf = makeLevelDat([
      ['LevelName', 8, '§x§f§f§0§0§0§0彩色§r名'],
      ['WorldGenSettings', 10, [['seed', 4, 42424242]]],
    ]);
    const s = nbt.summarize(buf);
    assert.equal(s.levelName, '彩色名');
    assert.equal(s.seed, 42424242);
  });

  await test('大列表截断（不卡顿）', () => {
    const big = { itemType: 10, items: Array.from({ length: 5000 }, (_, i) => [['i', 3, i]]) };
    const buf = makeLevelDat([['Big', 9, big]]);
    const root = nbt.readLevelDat(buf);
    assert.equal(root.Big.length, 512, '截断到 512');
  });

  await test('越界与坏数据抛错', () => {
    assert.throws(() => nbt.readLevelDat(Buffer.from([10])), /越界|Unexpected|NBT/);
    assert.throws(() => nbt.readLevelDat(zlib.gzipSync(Buffer.from([1, 0]))), /Compound/);
  });

  await test('未压缩与 zlib deflate 输入', () => {
    const w = new Writer();
    w.u1(10).str('').payload(10, [['A', 3, 7]]);
    const raw = w.toBuffer();
    assert.equal(nbt.readLevelDat(raw).A, 7);
    assert.equal(nbt.readLevelDat(zlib.deflateSync(raw)).A, 7);
  });

  await test('stripFormatting 直接暴露', () => {
    // §k 混乱体等格式码被剥离，文字保留
    assert.equal(nbt.stripFormatting('§k混乱§r§b蓝字'), '混乱蓝字');
    assert.equal(nbt.stripFormatting('无格式'), '无格式');
    assert.equal(nbt.stripFormatting('§x§f§f§0§0§0§0十六进制色'), '十六进制色');
  });

  summary();
}

run();
