'use strict';
/**
 * 首页：启动区（版本 / 玩家 / 内存 / 启动按钮）+ 状态展示 + 公告与新版本提示条。
 */
(function () {
  const { h, fmtSize, icon } = window.Dom;

  // ------------------------------------------------------------ 下拉浮层工具
  function openFloatPanel(anchor, panel, onClose) {
    panel.classList.add('float-panel');
    document.body.append(panel);
    const r = anchor.getBoundingClientRect();
    const pw = panel.offsetWidth || 320;
    const ph = panel.offsetHeight || 300;
    let left = Math.min(r.left, window.innerWidth - pw - 12);
    let top = r.bottom + 6;
    if (top + ph > window.innerHeight - 12) top = Math.max(12, r.top - ph - 6);
    panel.style.left = Math.max(8, left) + 'px';
    panel.style.top = Math.max(8, top) + 'px';
    const close = () => {
      panel.remove();
      document.removeEventListener('mousedown', onDoc, true);
      if (onClose) onClose();
    };
    const onDoc = (ev) => {
      if (!panel.contains(ev.target) && !anchor.contains(ev.target)) close();
    };
    setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0);
    return close;
  }

  function instanceLabel(select) {
    const list = window.Store.state.installed || [];
    const cur = list.find((v) => v.id === (select && select.value));
    if (!cur) return '（暂无实例）';
    return cur.id + (cur.loader && cur.loader !== '原版' ? ' · ' + cur.loader : '');
  }

  /** 当前域下的可用账户判断：站点型域只认对应皮肤站账户。 */
  function domainAccount() {
    const domain = window.DomainContext && window.DomainContext.active ? window.DomainContext.active() : null;
    const managed = Boolean(domain && !domain.personal);
    const root = managed && window.DomainContext.authRoot ? window.DomainContext.authRoot() : '';
    const account = window.Store.state.account || null;
    const normalize = (v) => String(v || '').replace(/\/+$/, '');
    const allowed = !managed || Boolean(account && account.mode === 'authlib' && normalize(account.root) === root);
    return { domain, managed, root, account, allowed };
  }

  /** 实例选择浮层：搜索列表 + 启动游戏大按钮（形态参考 SJMC） */
  function openInstancePicker(anchor, select) {
    const list = window.Store.state.installed || [];
    if (!list.length) { window.Toast.warn('还没有可启动的实例，先去「下载游戏」装一个吧'); return; }
    let chosen = select.value || (list[0] && list[0].id);
    const search = h('input.input', { placeholder: '搜索实例…', oninput: () => draw() });
    const rowsBox = h('div.inst-list');
    const panel = h('div.inst-picker');
    function draw() {
      window.Dom.clear(rowsBox);
      const q = search.value.trim().toLowerCase();
      const rows = list.filter((v) => !q || v.id.toLowerCase().includes(q) || String(v.mcVersion || '').toLowerCase().includes(q));
      for (const v of rows) {
        rowsBox.append(h('div.inst-row' + (v.id === chosen ? '.chosen' : ''), {
          onclick: () => {
            chosen = v.id;
            select.value = v.id;
            window.Store.set({ homeVersionId: v.id });
            if (els.versionTrigger) els.versionTrigger.textContent = instanceLabel(select);
            draw();
          },
        },
          h('span.inst-radio' + (v.id === chosen ? '.on' : '')),
          h('span.loader-mini', { style: { width: '20px', flex: 'none' }, innerHTML: window.LoaderIcon.svg(v.loader, 18) }),
          h('div.grow', { style: { minWidth: 0 } },
            h('div.inst-id.ellipsis', null, v.id),
            h('div.faint', null, (v.mcVersion || v.type) + (v.loader && v.loader !== '原版' ? ', ' + v.loader : '')),
          ),
        ));
      }
      if (!rows.length) rowsBox.append(h('div.faint', { style: { padding: '12px' } }, '没有匹配的实例'));
    }
    draw();
    let close = () => {};
    const launchBtn = h('button.btn.btn-primary.pressable', {
      style: { flex: 1, height: '46px', fontSize: '15.5px', fontWeight: 700 },
      onclick: async () => {
        close();
        select.value = chosen;
        window.Store.set({ homeVersionId: chosen });
        if (els.versionTrigger) els.versionTrigger.textContent = instanceLabel(select);
        await doLaunch(els.launchBtn);
      },
    }, '启动游戏');
    const gear = h('button.btn.iconbtn', { title: '版本管理', style: { width: '46px', height: '46px' }, onclick: () => { close(); window.app.goto('versions'); } }, '⚙');
    panel.append(search, rowsBox, h('div.row', { style: { gap: '8px', marginTop: '10px' } }, gear, launchBtn));
    close = openFloatPanel(anchor, panel);
    setTimeout(() => search.focus(), 30);
  }

  /** 账户切换浮层：头像 + 名字 + 模式，点击即切换 */
  async function openAccountPicker(anchor) {
    let store;
    try { store = await window.smcl.accountsList(); } catch { return; }
    const domain = window.DomainContext && window.DomainContext.active ? window.DomainContext.active() : null;
    const managed = Boolean(domain && !domain.personal);
    const domainRoot = (window.DomainContext && window.DomainContext.authRoot) ? window.DomainContext.authRoot() : '';
    const normalizeRoot = (v) => String(v || '').replace(/\/+$/, '');
    const list = ((store && store.list) || []).filter(
      (a) => !managed || (a.type === 'authlib' && normalizeRoot(a.payload && a.payload.root) === domainRoot)
    );
    if (!list.length) {
      window.Toast.warn(managed ? '当前域还没有登录账号，请先在账户页登录域账号' : '还没有账户，去账户页添加');
      return;
    }
    const names = (window.Store.get('settings') || {}).authlibNames || {};
    const labelOf = (a) => {
      if (a.type === 'msa') return '微软正版';
      if (a.type === 'offline') return '离线模式';
      const root = (a.payload && a.payload.root) || '';
      return names[root] || (a.payload && a.payload.serverName) || '皮肤站';
    };
    const panel = h('div.acct-picker');
    let close = () => {};
    for (const a of list) {
      const canvas = h('canvas', { width: 8, height: 8 });
      const row = h('div.acct-row' + (a.uid === store.activeId ? '.chosen' : ''), {
        onclick: async () => {
          close();
          try {
            const st = await window.smcl.accountsSwitch(a.uid);
            window.Store.set({ account: st, settings: await window.smcl.state().then((x) => x.settings) });
            window.app.updateAccountCard();
            window.Toast.success('已切换到：' + a.name);
            if (rootEl2) await render(rootEl2);
          } catch (e) { window.Toast.error(e.message); }
        },
      },
        h('span.inst-radio' + (a.uid === store.activeId ? '.on' : ''), { style: { flex: 'none' } }),
        canvas,
        h('div.grow', { style: { minWidth: 0 } },
          h('div', { style: { fontWeight: '650', fontSize: '13.5px' } }, a.name),
          h('div.faint', null, labelOf(a)),
        ),
      );
      window.smcl.getAvatar(a.uuid, a.name).then((r) => window.SkinView.drawHead(canvas, r && r.dataUrl)).catch(() => {});
      panel.append(row);
    }
    close = openFloatPanel(anchor, panel);
  }

  // ------------------------------------------------------------ 首页组件化（拖拽 / 缩放 / 刷新）
  const HOME_WIDGET_KEY = 'swustmcl.homeLayout.v12'; // 仅保存手动拖动/缩放的组件 // x/w 存比例，y/h 存像素
  const W_MIN = { w: 260, h: 150 };
  const W_MAX = { w: 920, h: 820 };
  // 每类组件单独的最大尺寸：启动卡不需要拉太大，日历/服务器更能吃空间
  const W_MAX_MAP = {
    launch: { w: 660, h: 520 },
    status: { w: 720, h: 520 },
    servers: { w: 920, h: 780 },
    calendar: { w: 860, h: 800 },
    announce: { w: 920, h: 420 },
    running: { w: 920, h: 160 },
    clock: { w: 760, h: 480 },
  };
  const maxOf = (id) => ({ ...W_MAX, ...(W_MAX_MAP[id] || {}) });
  const clampNum = (v, min, max) => Math.min(max, Math.max(min, v));

  function mountWidgets(canvas, widgets) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(HOME_WIDGET_KEY) || '{}') || {}; } catch {}
    const width = Math.max(640, canvas.clientWidth || 900);
    const gap = 16;
    // 三列默认：全部尺寸按画布宽度比例（x/y/w/h 同比例缩放，任何窗口下版式一致）
    const col1 = Math.round(width * 0.49);
    const col2 = Math.round(width * 0.235);
    const col3 = Math.max(240, width - col1 - col2 - gap * 2);
    // 紧凑默认：宽度按列比例，高度固定像素（大窗口下不会被等比放大成巨块）
    const c1 = Math.round((width - gap * 2) * 0.49);
    const c2 = Math.round((width - gap * 2) * 0.255);
    const c3 = Math.max(260, width - gap * 2 - c1 - c2);
    const x1 = 0;
    const x2 = c1 + gap;
    const x3 = x2 + c2 + gap;
    const def = {
      launch: { x: x1, y: 0, w: c1, h: 360 },
      clock: { x: x2, y: 0, w: c2, h: 280 },
      calendar: { x: x3, y: 0, w: c3, h: 440 },
      announce: { x: x2, y: 296, w: c2, h: 200 },
      servers: { x: x1, y: 376, w: c1, h: 330 },
      status: { x: x2, y: 512, w: c2, h: 300 }, // 运行环境：公告正下方（中列）
      running: { x: x1, y: 716, w: c1, h: 86 },
    };
    void col1; void col2; void col3;
    const holders = {};
    for (const w of widgets) {
      const sv = saved[w.id] || {};
      const d = def[w.id] || { x: 0, y: 0, w: 320, h: 240 };
      // x/w 可能存的是相对比例（0~1）：换算成当前宽度下的像素；y/h 直接用像素
      const pos = {
        x: sv.x != null && sv.x <= 1 ? sv.x * width : (sv.x != null ? sv.x : d.x),
        w: sv.w != null && sv.w <= 1 ? sv.w * width : (sv.w != null ? sv.w : d.w),
        y: sv.y != null ? sv.y : d.y,
        h: sv.h != null ? sv.h : d.h,
      };
      const mx = maxOf(w.id);
      pos.w = clampNum(pos.w, W_MIN.w, mx.w);
      pos.h = clampNum(pos.h, W_MIN.h, mx.h);
      const card = w.card;
      card.classList.add('widget-card');
      let head = card.querySelector('.card-head');
      if (!head) {
        head = h('div.card-head');
        const body = card.querySelector('.card-body');
        const innerTitle = body && body.querySelector(':scope > .section-title');
        if (innerTitle) innerTitle.remove();
        card.insertBefore(head, card.firstChild);
        head.append(h('div.card-title', null, w.title));
      }
      head.classList.add('widget-head');
      head.insertBefore(h('span.widget-grip', { title: '按住拖动' }, '⠿'), head.firstChild);
      head.append(h('button.iconbtn', { title: '刷新', onclick: (e) => { e.stopPropagation(); if (w.refresh) w.refresh(); } }, '↻'));
      const holder = h('div.home-widget', { style: { left: pos.x + 'px', top: pos.y + 'px', width: pos.w + 'px', height: pos.h + 'px' } });
      holder.dataset.widget = w.id;
      if (w.hidden) holder.style.display = 'none';
      holder.append(card, h('div.widget-resize', { title: '拖动缩放（有最大/最小限制）' }));
      canvas.append(holder);
      holders[w.id] = holder;
      bindDrag(canvas, holder, head);
      bindResize(canvas, holder, holder.querySelector('.widget-resize'));
    }
    updateCanvasHeight(canvas);
    // 默认布局不写缓存：只有用户手动拖动/缩放时才保存，避免启动过程中的中间态被固化
    if (!home._resizeBound) {
      home._resizeBound = true;
      let rt = null;
      window.addEventListener('resize', () => {
        if (rt) clearTimeout(rt);
        rt = setTimeout(() => {
          const c = document.querySelector('.home-canvas');
          if (c) applyResponsiveLayout(c);
        }, 160);
      });
    }
    return holders;
  }

  function bindDrag(canvas, holder, head) {
    head.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('button, input, select, a, .switch')) return;
      e.preventDefault();
      const sx = e.clientX;
      const sy = e.clientY;
      const ox = parseFloat(holder.style.left) || 0;
      const oy = parseFloat(holder.style.top) || 0;
      const move = (ev) => {
        const maxX = Math.max(0, canvas.clientWidth - holder.offsetWidth);
        holder.style.left = clampNum(ox + ev.clientX - sx, 0, maxX) + 'px';
        holder.style.top = Math.max(0, oy + ev.clientY - sy) + 'px';
        updateCanvasHeight(canvas);
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        resolveOverlaps(canvas, holder);
        saveWidgetFraction(canvas, holder);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  function bindResize(canvas, holder, handle) {
    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const sx = e.clientX;
      const sy = e.clientY;
      const ow = holder.offsetWidth;
      const oh = holder.offsetHeight;
      const mx = maxOf(holder.dataset.widget);
      const move = (ev) => {
        const left = parseFloat(holder.style.left) || 0;
        const maxW = Math.min(mx.w, Math.max(W_MIN.w, canvas.clientWidth - left));
        holder.style.width = clampNum(ow + ev.clientX - sx, W_MIN.w, maxW) + 'px';
        holder.style.height = clampNum(oh + ev.clientY - sy, W_MIN.h, mx.h) + 'px';
        updateCanvasHeight(canvas);
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        resolveOverlaps(canvas, holder);
        saveWidgetFraction(canvas, holder);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  function resolveOverlaps(canvas, holder) {
    const rectOf = (el) => ({ x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0, w: el.offsetWidth, h: el.offsetHeight });
    const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const others = [...canvas.querySelectorAll('.home-widget')].filter((el) => el !== holder && el.style.display !== 'none');
    const me = rectOf(holder);
    for (let i = 0; i < 80; i++) {
      let moved = false;
      for (const el of others) {
        const r = rectOf(el);
        if (hit(me, r)) {
          me.y = r.y + r.h + 12;
          moved = true;
        }
      }
      if (!moved) break;
    }
    holder.style.top = me.y + 'px';
    updateCanvasHeight(canvas);
  }

  function updateCanvasHeight(canvas) {
    let maxBottom = 460;
    for (const el of canvas.querySelectorAll('.home-widget')) {
      if (el.style.display === 'none') continue;
      maxBottom = Math.max(maxBottom, (parseFloat(el.style.top) || 0) + el.offsetHeight);
    }
    canvas.style.height = maxBottom + 28 + 'px';
  }

  function readSavedLayout() {
    try { return JSON.parse(localStorage.getItem(HOME_WIDGET_KEY) || '{}') || {}; } catch { return {}; }
  }
  function writeSavedLayout(out) {
    try { localStorage.setItem(HOME_WIDGET_KEY, JSON.stringify(out)); } catch {}
  }

  /** 只保存被手动拖动/缩放的组件；其它组件保持原比例，避免窗口缩放时的裁剪值被反写 */
  function saveWidgetFraction(canvas, holder) {
    const cw = Math.max(1, canvas.clientWidth || 1);
    const out = readSavedLayout();
    out[holder.dataset.widget] = {
      x: Math.round(((parseFloat(holder.style.left) || 0) / cw) * 1000) / 1000,
      w: Math.round((holder.offsetWidth / cw) * 1000) / 1000,
      y: Math.round(parseFloat(holder.style.top) || 0),
      h: holder.offsetHeight,
    };
    writeSavedLayout(out);
  }

  /** 首次挂载：只补没有记录过的组件（新组件），已有布局不动 */
  function saveMissingLayout(canvas) {
    const cw = Math.max(1, canvas.clientWidth || 1);
    const out = readSavedLayout();
    let changed = false;
    for (const el of canvas.querySelectorAll('.home-widget')) {
      const id = el.dataset.widget;
      if (out[id]) continue;
      out[id] = {
        x: Math.round(((parseFloat(el.style.left) || 0) / cw) * 1000) / 1000,
        w: Math.round((el.offsetWidth / cw) * 1000) / 1000,
        y: Math.round(parseFloat(el.style.top) || 0),
        h: el.offsetHeight,
      };
      changed = true;
    }
    if (changed) writeSavedLayout(out);
  }

  /** 窗口尺寸变化：横向按比例重排（拖动过的布局也不会跑偏/留大空白） */
  function applyResponsiveLayout(canvas) {
    if (!canvas) return;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(HOME_WIDGET_KEY) || '{}') || {}; } catch {}
    const cw = Math.max(640, canvas.clientWidth || 900);
    for (const el of canvas.querySelectorAll('.home-widget')) {
      const sv = saved[el.dataset.widget];
      if (!sv || sv.x == null || sv.w == null) continue;
      const mx = maxOf(el.dataset.widget);
      const left = clampNum((sv.x <= 1 ? sv.x * cw : sv.x), 0, Math.max(0, cw - 260));
      const widthPx = clampNum((sv.w <= 1 ? sv.w * cw : sv.w), W_MIN.w, Math.min(mx.w, cw - left));
      el.style.left = Math.round(left) + 'px';
      el.style.width = Math.round(widthPx) + 'px';
      if (sv.y != null) el.style.top = Math.round(sv.y) + 'px';
      if (sv.h != null) el.style.height = Math.round(clampNum(sv.h, W_MIN.h, mx.h)) + 'px';
    }
    updateCanvasHeight(canvas); // 只读比例渲染，不回写（避免裁剪值累积导致布局漂移）
  }

  // ------------------------------------------------------------ 时钟
  function clockCard() {
    const dateEl = h('div.clock-date');
    const timeEl = h('div.clock-time');
    const tzEl = h('span.clock-tz');
    const sloganEl = h('div.clock-slogan');
    const SLOGANS = ['一方一世界', '少年你相信命运么', '星光不负赶路人'];
    const sloganOf = (now) => SLOGANS[Math.floor(now.getTime() / 300000) % SLOGANS.length]; // 每 5 分钟轮换
    const tick = () => {
      const now = new Date();
      const pad = (x) => String(x).padStart(2, '0');
      dateEl.textContent = now.getFullYear() + '年' + pad(now.getMonth() + 1) + '月' + pad(now.getDate()) + '日';
      timeEl.textContent = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
      const off = -now.getTimezoneOffset() / 60;
      tzEl.textContent = 'UTC' + (off >= 0 ? '+' : '') + off;
      sloganEl.textContent = sloganOf(now);
    };
    tick();
    if (home._clockTimer) clearInterval(home._clockTimer);
    home._clockTimer = setInterval(() => {
      if (!document.body.contains(dateEl)) { clearInterval(home._clockTimer); home._clockTimer = null; return; }
      tick();
    }, 1000);
    const card = h('div.card.clock-card', null,
      h('div.card-body', null,
        dateEl,
        h('div.clock-time-row', null, timeEl, tzEl),
        sloganEl,
      ),
    );
    card.__refresh = () => tick();
    return card;
  }

  // ------------------------------------------------------------ 服务器列表
  function serverCard() {
    const body = h('div.card-body');
    const domain = window.DomainContext && window.DomainContext.active ? window.DomainContext.active() : null;
    const managed = Boolean(domain && !domain.personal);
    const card = h('div.card.server-card', null,
      h('div.card-head', null,
        h('div.card-title', { style: { minWidth: 0, display: 'flex', alignItems: 'center', gap: '6px' } },
          icon('server', 16),
          h('span.ellipsis', { title: managed ? (domain.name + ' · 服务器') : '服务器', style: { minWidth: 0 } }, managed ? (domain.name + ' · 服务器') : '服务器'),
        ),
        h('span.spacer'),
        managed ? null : h('button.btn.btn-ghost.btn-xs', { onclick: openAddServer }, '＋ 添加'),
      ),
      body,
    );
    drawServers(body);
    card.__refresh = () => drawServers(body);
    if (!home._srvTimer) {
      home._srvTimer = setInterval(() => {
        if (window.Store.state.view !== 'home') return;
        const b = document.querySelector('.server-card .card-body');
        if (b) drawServers(b);
      }, 60000);
    }
    return card;
  }

  async function drawServers(body) {
    if (!body) return;
    const domain = window.DomainContext && window.DomainContext.active ? window.DomainContext.active() : null;
    const managed = Boolean(domain && !domain.personal);
    let list = [];
    if (managed) {
      list = ((domain.manifest && domain.manifest.servers) || []).map((srv) => ({
        id: srv.id, name: srv.name, host: srv.host, port: srv.port,
        note: srv.note || '', instanceId: '', builtin: false, domain: true, pack: srv.pack || null,
      }));
    } else {
      try { list = await window.smcl.serversList(); } catch {}
    }
    window.Dom.clear(body);
    if (!list.length) {
      body.append(h('div.empty', null, h('div.empty-icon', null, icon('server', 34)), managed ? '该域还没有配置服务器' : '还没有服务器 —— 点右上「＋ 添加」'));
      return;
    }
    const installed = window.Store.get('installed') || [];
    for (const srv of list) {
      const dot = h('span.srv-dot.loading');
      const players = h('span.srv-players', null, '探测中…');
      const metaEl = h('div.srv-meta', null, srv.host + ':' + srv.port, players, srv.note ? ' · ' + srv.note : '');
      const row = h('div.srv-row', null,
        dot,
        h('div.grow', { style: { minWidth: 0 } },
          h('div.srv-name', null,
            srv.name,
            srv.builtin ? h('span.badge.badge-blue', { style: { marginLeft: '6px' } }, '校服') : null,
            srv.pack ? h('span.badge.badge-orange', { style: { marginLeft: '6px' } }, srv.pack.policy === 'required' ? '必装整合包' : '可选整合包') : null,
          ),
          metaEl,
          h('div.faint.srv-bind', null,
            srv.domain
              ? '来自域 · 由管理员维护'
              : srv.instanceId
                ? (installed.some((v) => v.id === srv.instanceId) ? '已安装「' + srv.instanceId + '」' : '绑定实例「' + srv.instanceId + '」（未安装）')
                : '未绑定整合包'),
        ),
        h('div.row', { style: { gap: '6px', flex: 'none' } },
          h('button.btn.btn-ghost.btn-xs', { title: '复制服务器地址', onclick: async () => {
            try { await window.smcl.clipboardWrite(srv.host + ':' + srv.port); window.Toast.success('已复制 ' + srv.host + ':' + srv.port); } catch (e) { window.Toast.error(e.message); }
          } }, '⧉'),
          h('button.btn.btn-primary.btn-xs.pressable', { title: '启动并加入服务器', onclick: () => joinServer(srv) }, '启动'),
          srv.domain ? null : h('button.btn.btn-ghost.btn-xs', { title: '移除这个服务器', style: { color: '#ff6369' }, onclick: () => editServer(srv) }, icon('trash', 14)),
        ),
      );
      body.append(row);
      window.smcl.serversPing(srv.host, srv.port).then((r) => {
        if (!r || !r.online) {
          dot.className = 'srv-dot off';
          players.textContent = ' · 离线';
          return;
        }
        dot.className = 'srv-dot on';
        players.textContent = ' · ' + ((r.players && r.players.online) || 0) + '/' + ((r.players && r.players.max) || 0) + ' 人在线';
        if (r.version && !srv.note) metaEl.append(' · ' + r.version);
      }).catch(() => { dot.className = 'srv-dot off'; players.textContent = ' · 离线'; });
    }
  }

  async function joinServer(srv) {
    const dom = domainAccount();
    if (dom.managed && !dom.allowed) {
      window.Toast.warn('请先登录「' + dom.domain.name + '」域账号');
      window.app.goto('account');
      return;
    }
    if (srv.pack && window.DomainPackJoin) {
      try {
        const prepared = await window.DomainPackJoin.prepareJoin(srv);
        if (!prepared) return;
        await window.smcl.launch(prepared.id, prepared.dir, { server: { host: srv.host, port: srv.port } });
        window.Store.set({ gameRunning: true });
      } catch (e) {
        window.Toast.error(String(e.message || e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').replace(/^Error:\s*/, ''));
      }
      return;
    }
    const installed = window.Store.get('installed') || [];
    let inst = installed.find((v) => v.id === srv.instanceId);
    if (!inst) {
      const picked = await pickInstanceForServer(srv, installed);
      if (!picked) return;
      inst = picked;
    }
    try {
      window.Toast.info('正在启动 ' + inst.id + ' 并加入 ' + srv.host + ':' + srv.port + '…');
      await window.smcl.launch(inst.id, inst.dir, { server: { host: srv.host, port: srv.port } });
      window.Store.set({ gameRunning: true });
    } catch (e) {
      window.Toast.error(String(e.message || e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').replace(/^Error:\s*/, ''));
    }
  }

  function pickInstanceForServer(srv, installed) {
    return new Promise((resolve) => {
      if (!installed.length) {
        window.Toast.warn('还没有安装实例，请先到「下载游戏」安装');
        return resolve(null);
      }
      const sel = h('select.select', { style: { width: '100%' } },
        ...installed.map((v) => h('option', { value: v.id, selected: v.id === srv.instanceId }, v.id + (v.mcVersion ? ' · ' + v.mcVersion : ''))));
      const m = window.Modal.open({
        title: '加入 ' + srv.name,
        body: (el) => el.append(
          h('div.muted', { style: { marginBottom: '10px' } }, srv.domain ? '选择用于加入 ' + srv.host + ':' + srv.port + ' 的实例：' : '选择用于加入 ' + srv.host + ':' + srv.port + ' 的实例（同时保存为该服务器的默认实例）：'),
          sel,
        ),
        footer: [
          h('button.btn', { onclick: () => m.close(null) }, '取消'),
          h('button.btn.btn-primary', { onclick: async () => {
            const inst = installed.find((v) => v.id === sel.value);
            if (inst && !srv.domain) {
              try { await window.smcl.serversSave(Object.assign({}, srv, { instanceId: inst.id })); } catch {}
            }
            m.close(inst || null);
          } }, srv.domain ? '启动' : '启动并记住'),
        ],
      });
      m.then((r) => resolve(r || null));
    });
  }

  function openAddServer() {
    const name = h('input.input', { placeholder: '服务器名称（如：好友服）' });
    const addr = h('input.input', { placeholder: '地址，如 mc.example.com 或 mc.example.com:25565' });
    const note = h('input.input', { placeholder: '备注（可选，如 周目 / 加载器）' });
    const m = window.Modal.open({
      title: '添加服务器',
      body: (el) => el.append(
        h('div.field', null, h('span.field-label', null, '名称'), name),
        h('div.field.mt-8', null, h('span.field-label', null, '地址'), addr),
        h('div.field.mt-8', null, h('span.field-label', null, '备注'), note),
      ),
      footer: [
        h('button.btn', { onclick: () => m.close(null) }, '取消'),
        h('button.btn.btn-primary', { onclick: async () => {
          const raw = addr.value.trim();
          if (!raw) return window.Toast.warn('请填写服务器地址');
          const mm = raw.match(/^([^:\s]+)(?::(\d+))?$/);
          if (!mm) return window.Toast.warn('地址格式不对，应为 host 或 host:port');
          try {
            await window.smcl.serversSave({ name: name.value.trim() || mm[1], host: mm[1], port: Number(mm[2]) || 25565, note: note.value.trim() });
            m.close(true);
            window.Toast.success('已添加服务器');
            drawServers(document.querySelector('.server-card .card-body'));
          } catch (e) { window.Toast.error(e.message); }
        } }, '添加'),
      ],
    });
  }

  function editServer(srv) {
    window.Modal.confirm({ title: '移除服务器「' + srv.name + '」？', message: '将从首页列表中移除（已绑定的实例不受影响）。', danger: true, okText: '移除' }).then(async (ok) => {
      if (!ok) return;
      try {
        await window.smcl.serversRemove(srv.id);
        window.Toast.success('已移除');
        drawServers(document.querySelector('.server-card .card-body'));
      } catch (e) { window.Toast.error(e.message); }
    });
  }

  // ------------------------------------------------------------ 日历（游玩记录）
  function calendarCard() {
    const card = h('div.card.cal-card');
    let month = new Date();
    let selected = new Date();
    let sessions = [];
    const body = h('div.card-body');
    card.append(h('div.card-head', null, h('div.card-title', null, icon('calendar', 16), '日历')), body);

    const fmtDay = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

    async function draw() {
      try { sessions = await window.smcl.historyList(); } catch { sessions = []; }
      const dayMap = new Map();
      for (const s of sessions) {
        const key = fmtDay(new Date(s.start));
        const dur = Math.max(0, (s.end || s.start) - (s.start || 0));
        const cur = dayMap.get(key) || { count: 0, ms: 0, ids: new Set() };
        cur.count += 1;
        cur.ms += dur;
        if (s.id) cur.ids.add(s.id);
        dayMap.set(key, cur);
      }
      window.Dom.clear(body);
      const year = month.getFullYear();
      const mon = month.getMonth();
      const head = h('div.row.cal-head', null,
        h('button.btn.btn-ghost.btn-xs', { onclick: () => { month = new Date(year, mon - 1, 1); draw(); } }, '‹'),
        h('div.grow', { style: { textAlign: 'center', fontWeight: '650' } }, year + '年' + (mon + 1) + '月'),
        h('button.btn.btn-ghost.btn-xs', { onclick: () => { month = new Date(year, mon + 1, 1); draw(); } }, '›'),
      );
      const grid = h('div.cal-grid');
      ['一', '二', '三', '四', '五', '六', '日'].forEach((w) => grid.append(h('div.cal-wd', null, w)));
      const first = new Date(year, mon, 1);
      const startOffset = (first.getDay() + 6) % 7;
      const daysInMonth = new Date(year, mon + 1, 0).getDate();
      for (let i = 0; i < startOffset; i++) grid.append(h('div.cal-cell.empty'));
      const today = new Date();
      for (let d = 1; d <= daysInMonth; d++) {
        const date = new Date(year, mon, d);
        const key = fmtDay(date);
        const rec = dayMap.get(key);
        const isSel = fmtDay(selected) === key;
        const isToday = fmtDay(today) === key;
        grid.append(h('div.cal-cell' + (rec ? '.played' : '') + (isSel ? '.sel' : '') + (isToday ? '.today' : ''), {
          onclick: () => { selected = date; draw(); },
        }, String(d)));
      }
      const selKey = fmtDay(selected);
      const rec = dayMap.get(selKey) || { ms: 0, ids: new Set() };
      const mins = Math.round(rec.ms / 60000);
      const ids = [...rec.ids];
      // 统计：今天 / 本周（周一起）/ 累计
      const now = new Date();
      const todayKey = fmtDay(now);
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7));
      weekStart.setHours(0, 0, 0, 0);
      let todayMs = 0;
      let weekMs = 0;
      let totalMs = 0;
      for (const [key, r] of dayMap) {
        totalMs += r.ms;
        if (key === todayKey) todayMs += r.ms;
        const d0 = new Date(key + 'T00:00:00').getTime();
        if (d0 >= weekStart.getTime()) weekMs += r.ms;
      }
      const fmtDur = (ms) => {
        const m = Math.round(ms / 60000);
        return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
      };
      body.append(
        head,
        grid,
        h('div.cal-stats', null,
          h('div.cal-stat', null, h('div.faint', null, '今天'), h('div.cal-stat-val', null, fmtDur(todayMs))),
          h('div.cal-stat', null, h('div.faint', null, '本周'), h('div.cal-stat-val', null, fmtDur(weekMs))),
          h('div.cal-stat', null, h('div.faint', null, '累计'), h('div.cal-stat-val', null, fmtDur(totalMs)), h('div.faint', null, '玩了 ' + dayMap.size + ' 天')),
        ),
        h('div.cal-detail', null,
          h('div.cal-detail-title', null, (selected.getMonth() + 1) + '月' + selected.getDate() + '日你游玩了：'),
          ids.length
            ? h('div.faint', null, ids.join('、') + ' · 共 ' + fmtDur(rec.ms))
            : h('div.faint', null, '这一天没有游玩记录。'),
        ),
      );
    }
    card.__refresh = draw;
    draw();
    return card;
  }


  let els = {};
  let rootEl2 = null;

  async function render(root) {
    rootEl2 = root;
    window.Dom.clear(root);
    const s = window.Store.state;

    // ---------- 提示条区 ----------
    const banners = h('div.col', { style: { gap: '10px' } });
    renderBanners(banners);

    // ---------- 启动区 ----------
    const versionSelect = h('select.select', {
      id: 'homeVersion',
      style: { display: 'none' },
      onchange: () => window.Store.set({ homeVersionId: versionSelect.value }),
    });
    fillVersions(versionSelect);
    const versionTrigger = h('button.btn.version-trigger', {
      style: { width: '100%', maxWidth: '320px', justifyContent: 'space-between', height: '38px' },
      onclick: () => openInstancePicker(versionTrigger, versionSelect),
    }, instanceLabel(versionSelect));

    const avatar = h('canvas.avatar-canvas', { width: 8, height: 8 });
    const domainAcc = domainAccount();
    const playerName = domainAcc.managed && !domainAcc.allowed
      ? '未登录域账号'
      : (domainAcc.account ? domainAcc.account.name : (s.settings ? s.settings.playerName : 'Steve'));
    const modeText = domainAcc.managed
      ? domainAcc.domain.name
      : (s.account ? (s.account.mode === 'msa' ? '微软正版' : s.account.mode === 'authlib' ? ((((window.Store.get('settings') || {}).authlibNames) || {})[s.account.root] || s.account.serverName || '皮肤站') : '离线账户') : '离线账户');
    const playerChip = h('div.player-chip', null,
      h('span.avatar-wrap', null, avatar),
      h('div', { style: { minWidth: 0 } },
        h('div.pc-name', { style: { fontSize: '14px', fontWeight: '650' } }, playerName),
        h('div.faint.pc-mode', { title: modeText }, modeText),
      ),
      h('button.btn.btn-ghost.btn-xs', { style: { marginLeft: 'auto' }, onclick: () => window.app.goto('account') }, '管理'),
    );
    playerChip.style.cursor = 'pointer';
    playerChip.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      const cur = domainAccount();
      if (cur.managed && !cur.allowed) { window.app.goto('account'); return; }
      openAccountPicker(playerChip);
    });

    const mem = s.settings ? s.settings.memory : 4096;
    const autoMem = s.settings ? s.settings.autoMemory !== false && s.settings.autoMemory === true : false;
    const setSlider = (val, label) => {
      memSlider.value = String(val);
      memSlider.style.setProperty('--fill', ((val - memSlider.min) / (memSlider.max - memSlider.min)) * 100 + '%');
      memValue.textContent = label || (val + ' MB');
    };
    const memSlider = h('input.slider', {
      type: 'range', min: '1024', max: String(memCap()), step: '512', value: String(mem),
      oninput: () => {
        memSlider.style.setProperty('--fill', ((memSlider.value - memSlider.min) / (memSlider.max - memSlider.min)) * 100 + '%');
        memValue.textContent = memSlider.value + ' MB';
      },
      onchange: async () => {
        // 手动拖动 = 切回自定义分配（自动开关随之关闭），PCL 同款交互
        if (window.Store.state.settings && window.Store.state.settings.autoMemory) {
          try {
            const s2 = await window.smcl.save({ autoMemory: false, memory: Number(memSlider.value) });
            window.Store.set({ settings: s2 });
            if (autoSwitch) autoSwitch.classList.remove('on');
            window.Toast.info('已切回手动分配：' + memSlider.value + ' MB（点开关恢复自动）');
          } catch (e) { window.Toast.error(e.message); }
        } else {
          window.smcl.save({ memory: Number(memSlider.value) }).catch((e) => window.Toast.error(e.message));
        }
      },
    });
    const memValue = h('span.slider-value', null, mem + ' MB');
    requestAnimationFrame(() => memSlider.style.setProperty('--fill', `${((memSlider.value - memSlider.min) / (memSlider.max - memSlider.min)) * 100}%`));

    // 账号变化 → 同步玩家卡片（登录/登出后）
    const syncPlayerChip = async () => {
      // 实时查当前 DOM：订阅只注册一次，但页面重渲染后元素会换新，不能捕获旧节点
      const dom = domainAccount();
      const acc = dom.account || {};
      const chip = document.querySelector('.view[data-view="home"] .player-chip') || playerChip;
      const nameEl = chip.querySelector('.pc-name');
      const modeEl = chip.querySelector('.pc-mode');
      const av = chip.querySelector('canvas');
      if (!nameEl) return;
      const blocked = dom.managed && !dom.allowed;
      nameEl.textContent = blocked ? '未登录域账号' : (acc.name || 'Steve');
      const mode = dom.managed
        ? dom.domain.name
        : (acc.mode === 'msa' ? '微软正版' : acc.mode === 'authlib' ? ((((window.Store.get('settings') || {}).authlibNames) || {})[acc.root] || acc.serverName || '皮肤站') : '离线账户');
      modeEl.textContent = mode;
      modeEl.title = mode;
      if (blocked) {
        if (av) await window.SkinView.drawHead(av, '');
        return;
      }
      try {
        const r = await window.smcl.getAvatar(acc.uuid || '', acc.name || 'Steve');
        if (av) await window.SkinView.drawHead(av, r && r.dataUrl);
      } catch {}
    };
    if (!home._accSub) { home._accSub = true; window.Store.on('account', () => syncPlayerChip()); }
    syncPlayerChip();

    // 自动分配开关
    const autoSwitch = h('span.switch' + (autoMem ? '.on' : ''), {
      title: '按物理内存自动分配（35%，2048~8192 MB）',
      onclick: async () => {
        const next = !autoMem;
        try {
          const s2 = await window.smcl.save({ autoMemory: next });
          window.Store.set({ settings: s2 });
          render(rootEl2 || document.querySelector('.view[data-view="home"]'));
        } catch (e) { window.Toast.error(e.message); }
      },
    });
    // 一键优化内存
    const freeBtn = h('button.btn.btn-ghost.btn-xs', {
      title: '整理系统工作集，释放物理内存（不会结束任何进程）',
      onclick: async () => {
        freeBtn.disabled = true;
        freeBtn.textContent = '优化中…';
        try {
          const r = await window.smcl.freeMemory();
          if (r.ok) window.Toast.success(`已整理 ${r.processes} / ${r.total || r.processes} 个进程（其余为系统进程，无权限）`);
          else window.Toast.warn('内存整理未完成：' + (r.error || '未知原因'));
        } catch (e) { window.Toast.error(e.message); }
        freeBtn.disabled = false;
        freeBtn.textContent = '优化内存';
      },
    }, '优化内存');

    const launchBtn = h('button.btn.btn-primary.btn-lg.launch-btn', {
      onclick: () => doLaunch(launchBtn),
    }, '启 动');
    if (s.gameRunning) setLaunching(launchBtn, false, '再启动一个');

    const launchCard = h('div.card.launch-card', null,
      h('div.launch-inner', null,
        h('div', null,
          h('div.field', null,
            h('span.field-label', null, '游戏版本'),
            versionTrigger,
          ),
        ),
        playerChip,
        h('div.field', null,
          h('div.row', { style: { justifyContent: 'space-between' } },
            h('div.row', { style: { gap: '8px' } },
              h('span.field-label', null, '内存分配'),
              autoSwitch,
              h('span.field-hint#memModeHint', null, autoMem ? '自动平衡 · 物理 35%' : '手动指定'),
            ),
            h('div.row', { style: { gap: '8px' } },
              freeBtn,
              h('span.field-hint', { id: 'memUsageHint' }, `物理 ${fmtSize(physicalMemory())}`),
            ),
          ),
          h('div.slider-wrap', null, memSlider, memValue),
        ),
        h('div.launch-btn-row', null, launchBtn),
      ),
    );

    // ---------- 状态区 ----------
    const statusGrid = h('div.status-grid', null,
      statusTile('Java 运行时', '☕', javaTileValue),
      statusTile('游戏目录', '📁', dirsTileValue),
      statusTile('已安装实例', '🎮', installedTileValue),
      statusTile('安全状态', '🛡', safetyTileValue),
    );
    const statusCard = h('div.card', null, h('div.card-body', null,
      h('div.section-title', { style: { marginTop: '0' } }, '运行环境'),
      statusGrid,
    ));

    // ---------- 运行中的游戏 ----------
    const runningCard = h('div.card.game-running', { style: { display: s.gameRunning ? 'flex' : 'none' } },
      h('span.pulse-dot', null),
      h('div.grow', null,
        h('div', { style: { fontWeight: '600', fontSize: '13.5px' } }, '游戏正在运行'),
        h('div.faint', null, '日志见底部抽屉'),
      ),
      h('button.btn.btn-danger.btn-sm.pressable', {
        onclick: async () => {
          try {
            await window.smcl.kill();
            window.Store.set({ gameRunning: false });
            window.Toast.info('已发送结束指令');
          } catch (e) { window.Toast.error(e.message); }
        },
      }, '结束游戏'),
    );

    // ---------- 公告 ----------
    const activeDomain = window.DomainContext && window.DomainContext.active ? window.DomainContext.active() : null;
    const domainManaged = Boolean(activeDomain && !activeDomain.personal);
    const domainAnnouncement = domainManaged ? (((activeDomain.manifest || {}).announcement || {}).text || '') : '';
    const announceCard = domainManaged
      ? h('div.card.announce-card', null,
          h('div.card-head', null, h('div.card-title.ellipsis', { title: activeDomain.name + ' · 公告', style: { minWidth: 0 } }, activeDomain.name + ' · 公告')),
          h('div.card-body', null,
            h('div.banner.banner-info', null, '✦', h('div.grow', null, domainAnnouncement || '域管理员还没有发布公告。')),
            h('div.muted', null, '当前处于站点型域，服务器、资源与账号由该域管理。'),
          ),
        )
      : h('div.card.announce-card', null,
          h('div.card-head', null, h('div.card-title', null, '公告')),
          h('div.card-body', null,
            h('div.banner.banner-info', null, '✦', h('div.grow', null, '星启 SWUSTMCL v1.0 发布 —— 欢迎通过「下载游戏」安装首个版本。')),
            h('div.muted', null, '支持 PCL / HMCL 目录自动发现、版本隔离、正版与离线登录、整合包一键导入。'),
          ),
        );

    // ---- 组件化首页：卡片可拖拽 / 缩放 / 刷新，互不重叠，页面可滚动 ----
    const srvCard = serverCard();
    const calCard = calendarCard();
    const widgets = [
      { id: 'launch', title: '启动', card: launchCard, refresh: () => { if (els.versionTrigger) els.versionTrigger.textContent = instanceLabel(els.versionSelect); } },
      { id: 'status', title: '运行环境', card: statusCard, refresh: () => home._refreshTiles && home._refreshTiles() },
      { id: 'running', title: '运行状态', card: runningCard, hidden: !s.gameRunning },
      { id: 'servers', title: '服务器', card: srvCard, refresh: () => srvCard.__refresh && srvCard.__refresh() },
      { id: 'calendar', title: '日历', card: calCard, refresh: () => calCard.__refresh && calCard.__refresh() },
      { id: 'announce', title: '公告', card: announceCard, refresh: domainManaged ? () => {} : () => renderBanners(banners) },
      { id: 'clock', title: '时钟', card: clockCard(), refresh: () => {} },
    ];
    const canvas = h('div.home-canvas.mt-12');
    root.append(banners, canvas);
    const holderMap = mountWidgets(canvas, widgets);
    els.canvas = canvas;
    els.runningWidget = holderMap.running;

    drawAvatar(avatar);
    els = { banners, versionSelect, versionTrigger, launchBtn, statusGrid, runningCard, memSlider };
    refreshStatus();

    // 数据异步到达后刷新状态瓦片（去重订阅）
    if (!home._subscribed) {
      home._subscribed = true;
      window.Store.on('javaList', () => home._refreshTiles && home._refreshTiles());
      window.Store.on('installed', () => { if (home._refreshTiles) home._refreshTiles(); const b = document.querySelector('.server-card .card-body'); if (b && window.Store.state.view === 'home') drawServers(b); });
      window.Store.on('dirs', () => home._refreshTiles && home._refreshTiles());
      // 游戏运行状态变化（含游戏自行退出）→ 同步启动按钮与运行卡
      window.Store.on('gameRunning', (running) => {
        if (els.launchBtn) setLaunching(els.launchBtn, false, running ? '再启动一个' : undefined);
        const holder = els.runningWidget || els.runningCard;
        if (holder) {
          holder.style.display = running ? 'block' : 'none';
          if (els.canvas) updateCanvasHeight(els.canvas);
        }
      });
    }
    // 内存实时模式：自动分配开启时，滑块每 2 秒跟随系统可用内存变化（PCL 同款）
    if (!home._memTimer) {
      home._memTimer = setInterval(async () => {
        if (window.Store.state.view !== 'home') return;
        const st = window.Store.state.settings;
        if (!st || !st.autoMemory) return;
        try {
          const u = await window.smcl.memoryUsage();
          const byTotal = (u.total * 0.35) / 1048576;
          const byFree = (u.free - 1.2 * 1073741824) / 1048576;
          const clamp = Math.max(1024, Math.min(8192, Math.round(Math.min(byTotal, Math.max(1024, byFree)) / 512) * 512));
          if (els.memSlider && document.activeElement !== els.memSlider) setSlider(clamp, clamp + ' MB（自动）');
          const hint = document.getElementById('memUsageHint');
          if (hint) hint.textContent = '可用 ' + fmtSize(u.free) + ' / 总 ' + fmtSize(u.total);
        } catch {}
      }, 2000);
    }
    home._refreshTiles = () => {
      if (!els.statusGrid) return;
      const tiles = els.statusGrid.querySelectorAll('.st-value');
      const fns = [javaTileValue, dirsTileValue, installedTileValue, safetyTileValue];
      tiles.forEach((el, i) => {
        Promise.resolve(fns[i]()).then((v) => {
          window.Dom.clear(el).append(...[].concat(v).filter(Boolean));
        }).catch(() => {});
      });
    };
    home._refreshTiles();
  }

  // ---- 状态瓦片取值（独立函数，便于数据到达后刷新） ----
  function javaTileValue() {
    const list = window.Store.state.javaList || [];
    if (!list.length) return h('span.badge.badge-orange', null, '未检测到');
    const need = latestRequiredJava();
    const ok = list.some((j) => j.major >= need);
    return [
      h('span.badge.' + (ok ? 'badge-green' : 'badge-orange'), null, `${list.length} 个可用`),
      h('span.faint', null, `最高 Java ${Math.max(...list.map((j) => j.major))} · 需 ${need}+`),
    ];
  }
  function dirsTileValue() {
    const dirs = window.Store.state.dirs || [];
    return [
      h('span', null, `${dirs.length} 个目录`),
      h('span.faint.ellipsis', null, dirs.length ? dirs.map((d) => d.name).join(' · ') : '未发现'),
    ];
  }
  function installedTileValue() {
    return h('span', null, `${(window.Store.state.installed || []).length} 个`);
  }
  function safetyTileValue() {
    const s = window.Store.state;
    return [
      h('span.badge.badge-green', null, '正常'),
      s.settings && s.settings.gpuFallback ? h('span.badge.badge-orange', null, 'GPU 兼容模式') : null,
    ];
  }

  function renderBanners(container) {
    window.Dom.clear(container);
    const s = window.Store.state;
    // 新正式版
    if (s.newReleaseInfo) {
      container.append(h('div.banner.banner-info', null,
        '⬆',
        h('div.grow', null, h('b', null, `Minecraft ${s.newReleaseInfo.version} 已发布`), '，点击右侧一键安装'),
        h('button.btn.btn-primary.btn-sm.pressable', {
          onclick: () => window.app.goto('download'),
        }, '去安装'),
        h('button.iconbtn', { title: '忽略', onclick: () => { window.Store.set({ newReleaseInfo: null }); renderBanners(container); } }, '✕'),
      ));
    }
    // 启动器更新
    if (s.updateInfo) {
      container.append(h('div.banner.banner-ok', null,
        '✦',
        h('div.grow', null, h('b', null, `启动器新版本 ${s.updateInfo.version}`), ' 可用'),
        h('button.btn.btn-primary.btn-sm.pressable', { onclick: () => window.app.installLauncherUpdate(s.updateInfo) }, '一键更新'),
      ));
    }
  }

  function statusTile(label, icon, valueFn) {
    const valueEl = h('div.st-value', null, h('span.skeleton', { style: { width: '80px', height: '14px' } }));
    const tile = h('div.card.status-tile', null,
      h('span.st-label', null, `${icon} ${label}`),
      valueEl,
    );
    Promise.resolve(valueFn()).then((v) => {
      window.Dom.clear(valueEl).append(...[].concat(v).filter(Boolean));
    }).catch(() => {
      window.Dom.clear(valueEl).append(h('span.faint', null, '获取失败'));
    });
    return tile;
  }

  async function refreshStatus() {
    if (!(window.Store.state.javaList || []).length) {
      try {
        const list = await window.smcl.detectJava();
        window.Store.set({ javaList: list });
      } catch {}
    }
  }

  function fillVersions(select) {
    const list = window.Store.state.installed || [];
    window.Dom.clear(select);
    if (!list.length) {
      select.append(h('option', { value: '' }, '（暂无实例，请先下载）'));
      return;
    }
    const preferred = window.Store.get('homeVersionId');
    const hit = list.find((v) => v.id === preferred);
    for (const v of list) {
      select.append(h('option', { value: v.id }, `${v.id}${v.loader !== '原版' ? ` · ${v.loader}` : ''}${v.dirName !== '主目录' ? `（${v.dirName}）` : ''}`));
    }
    select.value = (hit || list[0]).id;
    window.Store.set({ homeVersionId: select.value });
  }

  async function doLaunch(btn) {
    const id = els.versionSelect.value;
    if (!id) {
      window.Toast.warn('还没有可启动的实例，先去「下载游戏」装一个吧');
      return;
    }
    const dom = domainAccount();
    if (dom.managed && !dom.allowed) {
      window.Toast.warn('请先登录「' + dom.domain.name + '」域账号');
      window.app.goto('account');
      return;
    }
    const inst = (window.Store.state.installed || []).find((v) => v.id === id);
    setLaunching(btn, true, '启动中…');
    try {
      // 启动前自动补全缺失依赖（jar 损坏检测在主进程 repair.check 里）
      await window.smcl.launch(id, inst ? inst.dir : undefined);
      window.Toast.success(`已启动 ${id}`);
      setLaunching(btn, false, '再启动一个');
      window.Store.set({ gameRunning: true });
      if (els.runningWidget) { els.runningWidget.style.display = 'block'; if (els.canvas) updateCanvasHeight(els.canvas); }
    } catch (e) {
      setLaunching(btn, false);
      window.Toast.error(String(e.message || e).replace(/^Error invoking remote method '[^']+':s*(Error:s*)?/, '').replace(/^Error:s*/, ''));
      // 启动失败后立即刷新实例状态（可能缺 jar）
      window.app.refreshInstalled();
    }
  }

  function setLaunching(btn, busy, text) {
    window.Dom.clear(btn);
    if (busy) {
      btn.classList.add('busy');
      btn.disabled = true;
      btn.append(h('span.spinner'), h('span', { style: { marginLeft: '8px' } }, text || '启动中…'));
    } else {
      btn.classList.remove('busy');
      btn.disabled = false;
      btn.textContent = text || '启 动';
    }
  }

  async function drawAvatar(canvas) {
    const dom = domainAccount();
    if (dom.managed && !dom.allowed) {
      await window.SkinView.drawHead(canvas, '');
      return;
    }
    const acc = dom.account || window.Store.state.account;
    try {
      const r = await window.smcl.getAvatar(acc ? acc.uuid : '', acc ? acc.name : 'Steve');
      await window.SkinView.drawHead(canvas, r && r.dataUrl);
    } catch {}
  }

  function physicalMemory() {
    return (window.Store.state.sysMemory || 8 * 1024 * 1024 * 1024);
  }

  function memCap() {
    const phys = Math.floor(physicalMemory() / 1048576); // MB
    return Math.max(2048, Math.min(65536, Math.floor(phys * 0.9 / 512) * 512));
  }

  function latestRequiredJava() {
    const list = window.Store.state.installed || [];
    return list.reduce((m, v) => Math.max(m, v.javaMajor || 8), 8);
  }

  window.Pages = window.Pages || {};
  const home = {
    render,
    onShow() {
      if (els.versionSelect) { fillVersions(els.versionSelect); if (els.versionTrigger) els.versionTrigger.textContent = instanceLabel(els.versionSelect); }
      if (els.banners) renderBanners(els.banners);
      if (home._refreshTiles) home._refreshTiles();
      drawAvatar(document.querySelector('.player-chip canvas'));
    },
  };
  window.Pages.home = home;
})();
