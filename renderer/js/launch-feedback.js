'use strict';
/** 启动游戏时的统一加载遮罩与成功/失败提示。 */
(function () {
  const { h } = window.Dom;

  function cleanError(error) {
    return String((error && error.message) || error)
      .replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
      .replace(/^Error:\s*/, '');
  }

  /**
   * @param {() => Promise<any>} task
   * @param {{title?: string, success?: string}} options
   */
  async function run(task, options = {}) {
    const title = options.title || '正在启动游戏…';
    const text = h('div.muted', { style: { lineHeight: '1.8' } }, title);
    const detail = h('div.faint', { style: { marginTop: '6px', minHeight: '18px' } }, '请稍候，正在准备游戏进程…');
    const modal = window.Modal.open({
      title: '启动游戏',
      dismissible: false,
      body: (el) => el.append(
        h('div.row', { style: { gap: '12px', alignItems: 'flex-start' } },
          h('span.spinner', { style: { marginTop: '3px', flex: 'none' } }),
          h('div.grow', null, text, detail),
        ),
      ),
    });
    const off = window.smcl.onInstall((p) => {
      if (!p || !p.message) return;
      if (p.stage === 'preflight' || p.stage === 'meta' || p.stage === 'verify') detail.textContent = p.message;
    });
    try {
      const result = await task();
      off();
      modal.close(true);
      window.Toast.success(options.success || '游戏启动成功');
      return result;
    } catch (error) {
      off();
      modal.close(false);
      window.Toast.error(cleanError(error));
      throw error;
    }
  }

  window.LaunchFeedback = { run, cleanError };
})();
