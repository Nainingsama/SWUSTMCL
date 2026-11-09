'use strict';
/**
 * 弹窗：Promise 风格 open({title, body, footer})，关闭时 resolve。
 */
(function () {
  const { h } = window.Dom;
  let openModals = [];

  function open({ title, body, footer, size = '' }) {
    const root = document.getElementById('modalRoot');
    const overlay = h('div.modal-overlay');
    const modal = h(`div.modal.${size}`);
    const bodyEl = h('div.modal-body');

    const close = (result) => {
      overlay.style.animation = 'fadeIn .15s ease reverse both';
      modal.style.animation = 'modalIn .18s ease reverse both';
      setTimeout(() => {
        overlay.remove();
        openModals = openModals.filter((m) => m !== api);
      }, 170);
      api.resolve(result);
    };

    const headEl = h('div.modal-head', null,
      h('div.modal-title.grow', null, title || ''),
      h('button.iconbtn.pressable', { onclick: () => close(null), title: '关闭', innerHTML:
        '<svg width="12" height="12" viewBox="0 0 10 10"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" stroke-width="1.4"/></svg>' }),
    );

    const footEl = footer ? h('div.modal-foot', null, ...[].concat(footer)) : null;
    modal.append(headEl, bodyEl, ...(footEl ? [footEl] : []));
    overlay.append(modal);

    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close(null);
    });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') {
        close(null);
        document.removeEventListener('keydown', esc);
      }
    });

    if (typeof body === 'function') body(bodyEl, close);
    else if (body) bodyEl.append(...[].concat(body));

    root.append(overlay);
    const api = { close, overlay, modal, bodyEl, resolve: () => {} };
    api.resolve = () => {};
    api.close = close;
    // 让 close 可携带结果：包装 promise
    const promise = new Promise((res) => { api.resolve = res; });
    api.then = promise.then.bind(promise);
    openModals.push(api);
    return api;
  }

  /** 确认框，resolve(true/false) */
  function confirm({ title, message, detail, okText = '确定', danger = false }) {
    return new Promise((resolve) => {
      let done = false;
      const ok = h(`button.btn.${danger ? 'btn-danger' : 'btn-primary'}`, {
        onclick: () => { done = true; m.close(true); },
      }, okText);
      const m = open({
        title: title || '确认',
        body: (el) => {
          // 原生 append() 会把 null 转成字符串 "null"，必须先过滤
          el.append(
            ...[
              h('div', { style: { fontSize: '13.5px', lineHeight: '1.6' } }, message || ''),
              detail ? h('div.faint.mt-8', { style: { userSelect: 'text', wordBreak: 'break-all' } }, detail) : null,
            ].filter(Boolean),
          );
        },
        footer: [
          h('button.btn.pressable', { onclick: () => { done = true; m.close(false); } }, '取消'),
          ok,
        ],
      });
      m.then((r) => resolve(r === true));
    });
  }

  window.Modal = { open, confirm };
})();
