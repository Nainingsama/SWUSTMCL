'use strict';
/** minidump 解析：异常模块 + 栈回溯候选（崩溃诊断用） */
const fs = require('fs');
const path = require('path');

const file = process.argv[2];
const buf = fs.readFileSync(file);
console.log('sig:', buf.toString('ascii', 0, 4));
const numStreams = buf.readUInt32LE(8);
const dirRva = buf.readUInt32LE(12);
let modules = null;
let exception = null;

for (let i = 0; i < numStreams; i++) {
  const type = buf.readUInt32LE(dirRva + i * 12);
  const rva = buf.readUInt32LE(dirRva + i * 12 + 8);
  if (type === 4) modules = { rva };
  if (type === 6) exception = { rva };
}

const modList = [];
{
  const n = buf.readUInt32LE(modules.rva);
  for (let i = 0; i < n; i++) {
    const e = modules.rva + 4 + i * 108;
    const base = Number(buf.readBigUInt64LE(e));
    const size = buf.readUInt32LE(e + 8);
    const nameRva = buf.readUInt32LE(e + 20);
    const len = buf.readUInt32LE(nameRva);
    const name = buf.toString('utf16le', nameRva + 4, nameRva + 4 + len).replace(/\0/g, '');
    modList.push({ base, size, name });
  }
}
console.log('modules:', modList.length);

{
  const code = buf.readUInt32LE(exception.rva + 8);
  const addr = Number(buf.readBigUInt64LE(exception.rva + 8 + 16));
  console.log('exception code: 0x' + (code >>> 0).toString(16));
  console.log('exception address: 0x' + addr.toString(16));
  const ctxRva = buf.readUInt32LE(exception.rva + 164);
  const rip = Number(buf.readBigUInt64LE(ctxRva + 0xf8));
  const rsp = Number(buf.readBigUInt64LE(ctxRva + 0x98));
  console.log('RIP: 0x' + rip.toString(16));
  const hit = modList.find((m) => rip >= m.base && rip < m.base + m.size);
  if (hit) console.log('CRASH MODULE:', hit.name, '+0x' + (rip - hit.base).toString(16));
  else console.log('RIP not in any module (jumped into freed/unknown memory)');

  // 栈内存扫描：找出栈上指向模块的返回地址
  const found = [];
  for (let i = 0; i < numStreams; i++) {
    const type = buf.readUInt32LE(dirRva + i * 12);
    if (type !== 5 && type !== 9) continue; // MemoryListStream / Memory64ListStream
    const rva = buf.readUInt32LE(dirRva + i * 12 + 8);
    if (type === 5) {
      const n = buf.readUInt32LE(rva);
      for (let j = 0; j < n; j++) {
        const e = rva + 4 + j * 16;
        const start = Number(buf.readBigUInt64LE(e));
        const dataSize = buf.readUInt32LE(e + 8);
        const dataRva = buf.readUInt32LE(e + 12);
        if (rsp >= start && rsp < start + dataSize) {
          for (let k = 0; k < Math.min(600, (dataSize - (rsp - start)) / 8); k++) {
            const v = Number(buf.readBigUInt64LE(dataRva + (rsp - start) + k * 8));
            const m = modList.find((mm) => v >= mm.base && v < mm.base + mm.size);
            if (m && found.length < 40) {
              const short = m.name.split('\\').pop();
              if (!found.includes(`${short}+0x${(v - m.base).toString(16)}`)) {
                found.push(`${short}+0x${(v - m.base).toString(16)}`);
              }
            }
          }
        }
      }
    } else {
      // Memory64ListStream: NumberOfRanges(8), baseRva(8); entries: StartOfMemoryRange(8), DataSize(8)
      const n = Number(buf.readBigUInt64LE(rva));
      let dataRva = Number(buf.readBigUInt64LE(rva + 8));
      for (let j = 0; j < n; j++) {
        const e = rva + 16 + j * 16;
        const start = Number(buf.readBigUInt64LE(e));
        const dataSize = Number(buf.readBigUInt64LE(e + 8));
        if (rsp >= start && rsp < start + dataSize) {
          for (let k = 0; k < Math.min(600, (dataSize - (rsp - start)) / 8); k++) {
            const v = Number(buf.readBigUInt64LE(dataRva + (rsp - start) + k * 8));
            const m = modList.find((mm) => v >= mm.base && v < mm.base + mm.size);
            if (m && found.length < 40) {
              const short = m.name.split('\\').pop();
              if (!found.includes(`${short}+0x${(v - m.base).toString(16)}`)) {
                found.push(`${short}+0x${(v - m.base).toString(16)}`);
              }
            }
          }
        }
        dataRva += dataSize;
      }
    }
  }
  console.log('--- stack candidates (顺序约等于调用链，从新到旧) ---');
  found.forEach((f) => console.log(' ', f));
}
