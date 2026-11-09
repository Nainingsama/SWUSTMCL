'use strict';
/**
 * Toast 通知。
 */
(function () {
  const ICONS = { success: '✔', error: '✖', info: '✦', warn: '⚠' };

  function show(message, type = 'info', duration = 3200) {
    const root = document.getElementById('toastRoot');
    const { h } = window.Dom;
    const el = h(`div.toast.toast-${type}`, null,
      h('span.toast-icon', null, ICONS[type] || ICONS.info),
      h('span.toast-msg', null, String(message)),
    );
    root.append(el);
    const kill = () => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 240);
    };
    el.addEventListener('click', kill);
    setTimeout(kill, duration);
    // 同时写进日志
    if (window.smcl && type === 'error') console.error('[toast]', message);
  }

  window.Toast = {
    success: (m, d) => show(m, 'success', d),
    error: (m, d) => show(m, 'error', Math.max(d || 0, 4200)),
    info: (m, d) => show(m, 'info', d),
    warn: (m, d) => show(m, 'warn', Math.max(d || 0, 4200)),
  };
})();
