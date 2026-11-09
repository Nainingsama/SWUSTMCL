'use strict';
/**
 * 第三方软件兼容适配。
 *
 * 背景：搜狗输入法的附加组件（SGTool.exe 云服务 / SogouCloud.exe 云词库 /
 * SOGOUSmartAssistant.exe 智能助手）会向所有 GUI 进程注入 DLL，触发 Chromium
 * 的代码完整性断言 —— 任何新启动的 Electron 进程（包括 --version）都会在加载
 * 早期 int3 崩溃，表现为双击闪退。输入法核心（SogouImeBroker / 主 IME）不参与
 * 注入，结束这些附加组件后打字完全不受影响，搜狗也会在需要时自行重新拉起它们。
 *
 * 策略：主进程启动最早阶段同步检测；命中即临时结束，并在日志中说明根治方法
 * （搜狗设置里关闭「云输入 / 智能助手 / 今日热搜」）。可在设置里关闭本行为。
 */
const { spawnSync } = require('child_process');

const INJECTORS = ['SGTool.exe', 'SogouCloud.exe', 'SOGOUSmartAssistant.exe'];

/** 同步列出当前运行中的已知注入组件进程名 */
function findInjectors() {
  const found = [];
  const r = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 });
  if (r.status !== 0 || !r.stdout) return found;
  const text = r.stdout.toString('utf8', );
  for (const name of INJECTORS) {
    if (text.toLowerCase().includes(`"${name.toLowerCase()}"`)) found.push(name);
  }
  return found;
}

/**
 * 同步结束已知注入组件。返回 { stopped, detected }。
 * @param {(msg:string)=>void} [logFn]
 */
function stopKnownInjectorsSync(logFn) {
  const detected = findInjectors();
  if (!detected.length) return { stopped: [], detected };
  const stopped = [];
  for (const name of detected) {
    const r = spawnSync('taskkill', ['/F', '/IM', name, '/T'], { windowsHide: true, timeout: 5000 });
    if (r.status === 0) stopped.push(name);
  }
  if (detected.length && logFn) {
    logFn(
      `检测到搜狗输入法附加组件（${detected.join('、')}），它们会向本启动器注入 DLL 导致闪退，` +
      `已临时结束（不影响打字）。根治：搜狗输入法「设置 → 高级」里关闭云服务与智能助手。`
    );
  }
  return { stopped, detected };
}

module.exports = { INJECTORS, findInjectors, stopKnownInjectorsSync };
