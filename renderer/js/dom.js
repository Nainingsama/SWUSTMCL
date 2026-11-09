'use strict';
/**
 * DOM 工具：h() 元素构建 + 格式化 + 事件委托辅助。
 */
(function () {
  /**
   * h('div.card#list', { onclick }, children...)
   * tag 里可带 class 与 #id（# 可出现在任意段）；子项为字符串 / Node / 数组 / null
   */
  function h(spec, props, ...children) {
    let s = String(spec);
    let tag = 'div';
    let id = '';
    const idMatch = s.match(/#([\w-]+)/);
    if (idMatch) {
      id = idMatch[1];
      s = s.replace(idMatch[0], '');
    }
    const segs = s.split('.').filter(Boolean);
    if (segs.length && segs[0]) tag = segs.shift();
    const el = document.createElement(tag);
    if (id) el.id = id;
    if (segs.length) el.className = segs.join(' ');
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue;
        if (k.startsWith('on') && typeof v === 'function') {
          el.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (k === 'style' && typeof v === 'object') {
          Object.assign(el.style, v);
        } else if (k === 'dataset') {
          Object.assign(el.dataset, v);
        } else if (k in el && k !== 'list' && k !== 'form') {
          try { el[k] = v; } catch { el.setAttribute(k, v); }
        } else {
          el.setAttribute(k, v);
        }
      }
    }
    const append = (c) => {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) return c.forEach(append);
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    };
    children.forEach(append);
    return el;
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  }

  const fmtSize = (n) => {
    if (!n || n < 0) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
    return `${(n / 1073741824).toFixed(2)} GB`;
  };

  const fmtTime = (ms) => {
    if (!ms) return '—';
    const d = new Date(ms);
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const fmtRelative = (ms) => {
    if (!ms) return '从未';
    const diff = Date.now() - ms;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    if (diff < 7 * 86400000) return `${Math.floor(diff / 86400000)} 天前`;
    return fmtTime(ms);
  };

  const fmtNum = (n) => {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return String(n || 0);
  };

  const debounce = (fn, ms) => {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  };

  /** 挂载时平滑更新进度条宽度（CSS transition 负责插值） */
  function setProgress(barEl, percent) {
    barEl.classList.remove('indeterminate');
    barEl.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  }

  /** 下载量等异步体积填充防抖 */
  window.h = h;
  /** 通用单色线性图标（替代彩色 emoji） */
  const ICON_PATHS = {
    person: '<circle cx="10" cy="6.8" r="3.1"/><path d="M3.8 16.6c.9-3.2 3.4-4.8 6.2-4.8s5.3 1.6 6.2 4.8"/>',
    bolt: '<path d="M11.2 2.6L5.4 11h3.9l-.9 6.4 6-8.6h-3.9z"/>',
    apps: '<rect x="3.5" y="3.5" width="5.2" height="5.2" rx="1.2"/><rect x="11.3" y="3.5" width="5.2" height="5.2" rx="1.2"/><rect x="3.5" y="11.3" width="5.2" height="5.2" rx="1.2"/><rect x="11.3" y="11.3" width="5.2" height="5.2" rx="1.2"/>',
    server: '<rect x="3" y="4" width="14" height="5" rx="1.4"/><rect x="3" y="11" width="14" height="5" rx="1.4"/><path d="M6 6.5h.1M6 13.5h.1"/>',
    calendar: '<rect x="3.2" y="4.6" width="13.6" height="12" rx="1.6"/><path d="M3.2 8.2h13.6M6.6 3.2v2.6M13.4 3.2v2.6"/>',
    cubes: '<path d="M10 2.5l6 3.2v5.2l-6 3.2-6-3.2V5.7z"/><path d="M4 5.7l6 3.2 6-3.2M10 8.9v6.2"/>',
    refresh: '<path d="M15.6 8.2A5.6 5.6 0 1 0 16 12.4"/><path d="M15.6 3.6v4.6h-4.6"/>',
    plus: '<path d="M10 4.5v11M4.5 10h11"/>',
    folder: '<path d="M3 5.8h5.2l1.4 1.9H17v7.5H3z"/>',
    play: '<path d="M7 4.8l7.6 5.2L7 15.2z"/>',
    trash: '<path d="M5 6h10M8.2 6V4.6h3.6V6M6.6 6l.7 9.2h5.4L13.4 6M8.6 8.6v4.8M11.4 8.6v4.8"/>',
  };
  function icon(name, size = 16) {
    const el = h('span', { style: { display: 'inline-flex', width: size + 'px', height: size + 'px', flex: 'none', alignItems: 'center' } });
    el.innerHTML = '<svg viewBox="0 0 20 20" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + (ICON_PATHS[name] || '') + '</svg>';
    return el;
  }

  window.Dom = { h, clear, fmtSize, fmtTime, fmtRelative, fmtNum, debounce, setProgress, icon };
})();
