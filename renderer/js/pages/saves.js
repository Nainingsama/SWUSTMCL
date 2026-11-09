'use strict';
/**
 * 存档管理：跨目录扫描 saves（含版本隔离实例），
 * 缩略图列表 + 分组（文件夹/版本/时间）+ 定位/回收站。
 */
(function () {
  const { h, fmtSize, fmtRelative } = window.Dom;
  let rootEl = null;
  let saves = [];
  let loading = false;

  async function render(root) {
    rootEl = root;
    window.Dom.clear(root);
    const groupSel = h('select.select', { style: { maxWidth: '160px' }, onchange: (e) => { window.Store.set({ saveGroup: e.target.value }); drawList(); } },
      h('option', { value: 'folder' }, '按实例分组'),
      h('option', { value: 'version' }, '按版本分组'),
      h('option', { value: 'time' }, '按时间分组'),
    );
    groupSel.value = window.Store.get('saveGroup') || 'folder';

    const refreshBtn = h('button.btn.btn-sm.pressable', { onclick: () => load() }, '⟳ 重新扫描');

    root.append(
      h('div.section-title', null, '存档管理', h('span.hint#savesHint', null, '扫描所有实例的 saves 目录（只读 level.dat，不碰区块）')),
      h('div.row.mb-12', null, groupSel, h('span.spacer'), refreshBtn),
      h('div#savesList'),
    );
    if (!saves.length) load();
    else drawList();
  }

  async function load() {
    if (loading) return;
    loading = true;
    const list = rootEl.querySelector('#savesList');
    window.Dom.clear(list).append(h('div.empty', null,
      h('span.spinner', { style: { width: '22px', height: '22px', border: '2px solid rgba(255,255,255,0.2)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin .8s linear infinite' } }),
      '正在扫描存档…（解析 level.dat）'));
    try {
      saves = await window.smcl.saves();
    } catch (e) {
      window.Dom.clear(list).append(h('div.empty', null, `扫描失败：${e.message}`));
    } finally {
      loading = false;
      const hint = rootEl.querySelector('#savesHint');
      if (hint) hint.textContent = `共 ${saves.length} 个存档 · 只读 level.dat，绝不加载区块数据`;
      drawList();
    }
  }

  function drawList() {
    const list = rootEl.querySelector('#savesList');
    if (!list) return;
    window.Dom.clear(list);
    if (!saves.length) {
      list.append(h('div.empty', null, h('div.empty-icon', null, '🗺'), '没有发现存档'));
      return;
    }

    const group = window.Store.get('saveGroup') || 'folder';
    const groups = new Map();
    for (const s of saves) {
      let key, label;
      if (group === 'folder') { key = `${s.dirName}|${s.instanceId || ''}`; label = s.instanceId ? `${s.dirName} › ${s.instanceId}` : `${s.dirName} · 全局存档`; }
      else if (group === 'version') { key = s.version || '未知版本'; label = s.version || '未知版本'; }
      else {
        const d = new Date(s.lastPlayed || 0);
        key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        label = d.getFullYear() === 1970 ? '时间未知' : `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
      }
      if (!groups.has(key)) groups.set(key, { label, items: [] });
      groups.get(key).items.push(s);
    }

    for (const [, g] of groups) {
      list.append(h('div.save-group-head', null, g.label, h('span.faint', null, `${g.items.length}`)));
      const grid = h('div.grid.grid-auto');
      for (const s of g.items) grid.append(saveCard(s));
      list.append(grid);
    }
  }

  function saveCard(s) {
    const thumb = s.icon
      ? h('img.save-thumb', { src: s.icon, loading: 'lazy' })
      : h('div.save-thumb', null, '🌄');
    return h('div.card.hoverable.save-card', null,
      thumb,
      h('div.save-info', null,
        h('div.save-name.ellipsis', null, s.name),
        h('div.save-stats', null,
          s.version ? h('span.badge.badge-blue', null, s.version) : null,
          h('span.badge', null, s.gameType || '未知模式'),
          s.difficulty ? h('span.badge', null, s.difficulty) : null,
          s.hardcore ? h('span.badge.badge-red', null, '极限') : null,
          s.wasModded ? h('span.badge.badge-orange', null, '模组') : null,
          s.broken ? h('span.badge.badge-red', null, 'level.dat 损坏') : null,
        ),
        h('div.faint', null, `最后游玩 ${fmtRelative(s.lastPlayed)} · ${fmtSize(s.size)}`),
      ),
      h('div.save-actions', null,
        h('button.iconbtn', { title: '定位到文件夹', onclick: () => window.smcl.openPath(s.path).catch((e) => window.Toast.error(e.message)) }, '📂'),
        h('button.iconbtn', { title: '移至回收站', style: { color: '#ff6369' }, onclick: () => trashOne(s) }, window.Dom.icon('trash', 15)),
      ),
    );
  }

  async function trashOne(s) {
    const ok = await window.Modal.confirm({
      title: '移至回收站',
      message: `确定把存档「${s.name}」移至回收站吗？`,
      detail: s.path,
      okText: '移入回收站',
      danger: true,
    });
    if (!ok) return;
    try {
      await window.smcl.trashSave(s.path);
      saves = saves.filter((x) => x.path !== s.path);
      drawList();
      window.Toast.success('已移入回收站');
    } catch (e) {
      window.Toast.error(e.message.replace(/^Error: /, ''));
    }
  }

  window.Pages = window.Pages || {};
  window.Pages.saves = {
    render,
    onShow() { if (saves.length) drawList(); else load(); },
    onProgress(p) {
      const hint = rootEl && rootEl.querySelector('#savesHint');
      if (hint && p.total) hint.textContent = `扫描中 ${p.done}/${p.total}…`;
    },
  };
})();
