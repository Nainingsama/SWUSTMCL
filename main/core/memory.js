'use strict';
/**
 * 内存优化：用 PSAPI EmptyWorkingSet 把各进程工作集换出物理内存。
 * 这是 Windows 上“一键清理内存”的标准实现：
 *  - 对自己有句柄权限的进程生效，系统进程失败被忽略；
 *  - 不结束任何进程，无副作用（页面下次访问会自动换回）。
 * 返回处理的进程数量级，用于界面提示。
 */
const { execFile } = require('child_process');

const SCRIPT = `
$sig = '[DllImport("psapi.dll")] public static extern bool EmptyWorkingSet(IntPtr h);'
Add-Type -MemberDefinition $sig -Name W -Namespace N | Out-Null
$n = 0
$t = 0
Get-Process | ForEach-Object {
  $t++
  try {
    if (-not $_.Handle) { return }
    if ([N.W]::EmptyWorkingSet($_.Handle)) { $n++ }
  } catch {}
}
Write-Output "$n $t"
`;

/**
 * 清理工作集。
 * @param {number} [timeoutMs] 默认 15s
 * @returns {Promise<{ok:boolean, processes:number, total:number, error?:string}>}
 */
function freeWorkingSets(timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', SCRIPT],
      { windowsHide: true, timeout: timeoutMs },
      (err, stdout) => {
        if (err) {
          return resolve({ ok: false, processes: 0, total: 0, error: err.message });
        }
        const m = String(stdout).trim().match(/(\d+)\s+(\d+)/);
        const n = m ? parseInt(m[1], 10) : 0;
        const t = m ? parseInt(m[2], 10) : 0;
        resolve({ ok: true, processes: Number.isFinite(n) ? n : 0, total: Number.isFinite(t) ? t : 0 });
      }
    );
  });
}

/** 按物理内存自动计算游戏分配量（MB）：物理内存的 35%，2G ~ 8G 之间取整到 512 */
function autoMemoryMB(totalBytes) {
  const totalMB = Math.floor(totalBytes / 1048576);
  const raw = Math.round((totalMB * 0.35) / 512) * 512;
  return Math.min(8192, Math.max(2048, raw));
}

/**
 * 实时自动分配：优先看「当前可用内存」——
 *   推荐 = min(物理内存 35%, 可用内存 − 1.2GB 系统预留)，1024 ~ 8192 取整到 512。
 * 可用内存充足时贴近 35% 上限；内存紧张时自动让路，避免系统和游戏互相挤压。
 */
function autoMemoryFromUsage() {
  const total = require('os').totalmem();
  const free = require('os').freemem();
  const byTotal = (total * 0.35) / 1048576;
  const byFree = (free - 1.2 * 1073741824) / 1048576;
  const raw = Math.min(byTotal, Math.max(1024, byFree));
  const rec = Math.round(raw / 512) * 512;
  return Math.min(8192, Math.max(1024, rec));
}

function usage() {
  return { total: require('os').totalmem(), free: require('os').freemem() };
}

module.exports = { freeWorkingSets, autoMemoryMB, autoMemoryFromUsage, usage };
