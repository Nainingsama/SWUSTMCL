'use strict';
/** 侧栏宽度手动拖拽：可缩成图标栏（有最小宽度），双击恢复默认；宽度记忆 */
(function () {
  const sb = document.querySelector('.sidebar');
  const handle = document.getElementById('sidebarResizer');
  if (!sb || !handle) return;
  const KEY = 'swustmcl.sidebarWidth';
  const MIN = 64;
  const MAX = 360;
  const COLLAPSE = 150;
  const DEFAULT = 216;

  function clampW(w) { return Math.max(MIN, Math.min(MAX, w)); }
  function applyWidth(w) {
    const width = clampW(w);
    sb.style.width = Math.round(width) + 'px';
    sb.classList.toggle('collapsed', width < COLLAPSE);
  }
  function save(w) {
    try { localStorage.setItem(KEY, String(Math.round(clampW(w)))); } catch {}
  }

  const saved = Number(localStorage.getItem(KEY) || 0);
  if (saved >= MIN) applyWidth(saved);

  let dragging = false;
  let startX = 0;
  let startW = 0;
  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX;
    startW = sb.getBoundingClientRect().width;
    document.body.classList.add('resizing-sidebar');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    applyWidth(startW + (e.clientX - startX));
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('resizing-sidebar');
    save(sb.getBoundingClientRect().width);
    // 布局重新自适应（首页组件等）
    window.dispatchEvent(new Event('resize'));
  });
  handle.addEventListener('dblclick', () => {
    applyWidth(DEFAULT);
    save(DEFAULT);
    window.dispatchEvent(new Event('resize'));
  });
})();
