'use strict';
/**
 * 整合包：导入（预览 → 同名自动改名 → 安装 → 校验依赖）+ 导出（计划预览 → zip）。
 */
(function () {
  const { h, fmtSize } = window.Dom;
  let rootEl = null;
  let inspecting = null; // {file, info}

  const EXPORT_PRESET_KEY = 'swustmcl.exportPreset';
  const EXPORT_DEFAULTS = {
    packName: '', packVersion: '1.0.0',
    mods: true, modConfig: true, bodySettings: true,
    personal: false, maps: false, screenshots: false, servers: false, resources: false,
  };
  let exportPreset = (() => {
    try { return { ...EXPORT_DEFAULTS, ...(JSON.parse(localStorage.getItem(EXPORT_PRESET_KEY) || '{}') || {}) }; }
    catch { return { ...EXPORT_DEFAULTS }; }
  })();

  function render(root) {
    rootEl = root;
    window.Dom.clear(root);
    let exportSel = null, exportName = null, exportVersion = null;
    const exportOpts = { ...exportPreset };

    const drop = h('div.dropzone', {
      onclick: () => pickFile(),
    },
      h('div.dz-icon', null, '📦'),
      h('div', { style: { fontSize: '14px', fontWeight: '600' } }, '拖入或点击选择整合包 zip'),
      h('div.faint', null, '支持 Modrinth（.mrpack）/ CurseForge / PCL·HMCL 导出的 zip 包'),
    );
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragover'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      drop.classList.remove('dragover');
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f && /\.(zip|mrpack)$/i.test(f.name)) pickPath(window.smcl.pathForFile ? window.smcl.pathForFile(f) : f.path);
      else window.Toast.warn('请拖入 .mrpack 或 .zip 整合包');
    });

    const progWrap = h('div', { style: { display: 'none', flexDirection: 'column', gap: '8px', marginTop: '14px' } },
      h('div.progress', null, h('div.progress-bar#packBar', { style: { width: '0%' } })),
      h('div.progress-meta', null, h('span#packMsg', null, ''), h('span#packPct.tnum', null, '')),
    );

    root.append(
      h('div.section-title', null, '导入整合包'),
      h('div.card', null, h('div.card-body', null, drop, progWrap)),
      h('div.section-title', null, '导出整合包', h('span.hint', null, '可自选导出内容；PCL/HMCL/YMCL 推荐 PCL 兼容 zip，Modrinth 用 .mrpack')),
      h('div.card', null,
        h('div.card-body', null,
          h('div.row.row-wrap', { style: { gap: '12px', alignItems: 'flex-end' } },
            h('div.field.grow', { style: { minWidth: '220px' } },
              h('span.field-label', null, '选择实例'),
              exportSel = buildInstanceSelect(),
            ),
            h('div.field.grow', { style: { minWidth: '160px' } },
              h('span.field-label', null, '整合包名称'),
              exportName = h('input.input', { value: exportPreset.packName || '', placeholder: '默认使用实例名' }),
            ),
            h('div.field', { style: { width: '120px', flex: 'none' } },
              h('span.field-label', null, '整合包版本'),
              exportVersion = h('input.input', { value: exportPreset.packVersion || '1.0.0' }),
            ),
          ),
          h('div.export-title', null, '导出内容列表'),
          exportCheckRow('游戏本体', '正式版与加载器由启动器在导入时自动安装', true, () => {}, 0, true),
          exportCheckRow('游戏本体设置', '键位、音量、视频设置等（options.txt）', exportPreset.bodySettings, (v) => { exportOpts.bodySettings = v; }, 1),
          exportCheckRow('游戏本体个人信息', '命令历史、已保存的快捷栏等', exportPreset.personal, (v) => { exportOpts.personal = v; }, 1),
          exportCheckRow('Mod 模组', 'mods 目录下的所有模组 jar', exportPreset.mods, (v) => { exportOpts.mods = v; }, 0),
          exportCheckRow('Mod 设置与任务书', 'config / defaultconfigs / ftbquests / patchouli_books / kubejs / scripts', exportPreset.modConfig, (v) => { exportOpts.modConfig = v; }, 1),
          exportCheckRow('已绘制的地图', 'Xaero / JourneyMap 等地图缓存', exportPreset.maps, (v) => { exportOpts.maps = v; }, 1),
          exportCheckRow('截图', 'screenshots 目录', exportPreset.screenshots, (v) => { exportOpts.screenshots = v; }, 0),
          exportCheckRow('多人游戏服务器列表', 'servers.dat', exportPreset.servers, (v) => { exportOpts.servers = v; }, 0),
          exportCheckRow('资源包与光影', 'resourcepacks / shaderpacks', exportPreset.resources, (v) => { exportOpts.resources = v; }, 0),
          h('div.row.mt-12', { style: { gap: '8px', flexWrap: 'wrap' } },
            h('button.btn.btn-primary.pressable', { onclick: () => exportFlow(exportSel, exportName, exportVersion, exportOpts) }, '生成导出计划'),
            h('button.btn.btn-ghost.btn-sm.pressable', { onclick: openExportGuide }, '整合包制作指南'),
          ),
          h('div#exportPlanBox'),
        ),
      ),
    );

    // 切换实例时同步整合包名称与版本，避免沿用上一个实例的填写内容
    const syncExportFields = () => {
      if (!exportSel) return;
      const [dir, id] = String(exportSel.value || '').split('|');
      const inst = (window.Store.get('installed') || []).find((v) => v.id === id && (!dir || v.dir === dir));
      if (exportName) exportName.value = inst ? (inst.displayName || inst.id) : id;
      if (exportVersion) exportVersion.value = '1.0.0';
    };
    if (exportSel) {
      exportSel.addEventListener('change', syncExportFields);
      syncExportFields();
    }
  }

  function buildInstanceSelect() {
    const sel = h('select.select', null);
    const list = window.Store.get('installed') || [];
    for (const v of list) {
      sel.append(h('option', { value: `${v.dir}|${v.id}` }, `${v.id}（${v.dirName}）`));
    }
    return sel;
  }

  async function pickFile() {
    try {
      const file = await window.smcl.pickPack();
      if (file) pickPath(file);
    } catch {}
  }

  async function pickPath(file) {
    window.Toast.info('正在解析整合包…');
    let info;
    try {
      info = await window.smcl.inspectPack(file);
    } catch (e) {
      window.Toast.error(e.message.replace(/^Error: /, ''));
      return;
    }
    inspecting = { file, info };
    showPreview(info);
  }

  function showPreview(info) {
    const FMT = { modrinth: 'Modrinth', curseforge: 'CurseForge', mcbbs: 'MCBBS', raw: 'PCL/HMCL 裸目录' };
    let modalRef = null;
    const close = (name) => { if (modalRef) modalRef.close(name || true); };

    modalRef = window.Modal.open({
      title: '整合包预览',
      body: (el) => {
        el.append(
          h('div.pack-preview-grid', null,
            h('div.ver-icon', { style: { width: '56px', height: '56px', fontSize: '20px' } }, (info.loader || 'MC').slice(0, 2)),
            h('div.col', { style: { gap: '6px' } },
              h('div', { style: { fontSize: '17px', fontWeight: '700' } }, info.name),
              info.author ? h('div.faint', null, `作者：${info.author}`) : null,
              info.description ? h('div.muted', null, info.description) : null,
              h('div.row.row-wrap.mt-8', null,
                h('span.badge', null, FMT[info.format] || info.format),
                info.mcVersion ? h('span.badge.badge-blue', null, `MC ${info.mcVersion}`) : null,
                info.loader ? h('span.badge.badge-purple', null, `${info.loader} ${info.loaderVersion || ''}`) : null,
                h('span.badge', null, `📦 ${info.modCount} 个模组文件`),
                h('span.badge', null, `${info.entryCount} 个条目`),
              ),
            ),
          ),
          h('hr.divider'),
          h('div.muted', null,
            '导入时将：自动创建版本隔离实例（重名自动加序号）→ 自动安装缺失的版本底座与加载器 → 解包 overrides → 下载清单文件 → 校验依赖完整性。'),
          h('div.field.mt-12', null,
            h('span.field-label', null, '实例名（同名实例将自动加序号）'),
            h('input.input#packNameInput', { value: info.name }),
          ),
        );
      },
      footer: [
        h('button.btn.pressable', { onclick: () => close(null) }, '取消'),
        h('button.btn.btn-primary.pressable', {
          onclick: () => {
            const input = document.querySelector('#packNameInput');
            const name = input ? input.value.trim() : info.name;
            close(name);
            doImport(name);
          },
        }, '开始导入'),
      ],
    });
  }

  async function doImport(customName) {
    if (!inspecting) return;
    const bar = document.getElementById('packBar');
    const msg = document.getElementById('packMsg');
    const pct = document.getElementById('packPct');
    const wrap = bar.closest('div[style*="display: none"], div[style*="display:none"]');
    if (wrap) wrap.style.display = 'flex';

    try {
      // 自定义实例名：写入待导入信息（主进程会用同名自动改名逻辑兜底）
      const r = await window.smcl.installPack(inspecting.file, customName);
      window.Toast.success(`导入完成：${r.id}${r.warnings && r.warnings.length ? `（${r.warnings.length} 个警告）` : ''}`);
      if (r.warnings && r.warnings.length) {
        window.Modal.open({
          title: '导入完成，但有部分文件失败',
          body: (el) => el.append(h('div.col', { style: { gap: '6px' } },
            ...r.warnings.slice(0, 30).map((w) => h('div.faint', { style: { wordBreak: 'break-all' } }, `• ${w}`)))),
        });
      }
      if (r.dependencies && !r.dependencies.ok) {
        window.Toast.warn(`有 ${r.dependencies.missing} 个依赖文件缺失，可在「版本管理」里点 🔧 修复`);
      }
      window.app.refreshInstalled();
      window.app.goto('versions');
    } catch (e) {
      window.Toast.error(e.message.replace(/^Error: /, ''));
    } finally {
      inspecting = null;
      setTimeout(() => { if (wrap) wrap.style.display = 'none'; bar.style.width = '0%'; }, 1800);
    }
  }

  function exportCheckRow(label, desc, checked, onChange, level = 0, disabled = false) {
    const cb = h('input', {
      type: 'checkbox', checked: Boolean(checked), disabled,
      style: { width: '15px', height: '15px', marginTop: '2px', accentColor: 'var(--accent)', flex: 'none' },
      onchange: () => onChange(cb.checked),
    });
    return h('label.export-check' + (level ? '.child' : '') + (disabled ? '.disabled' : ''), null,
      cb,
      h('div.grow', { style: { minWidth: 0 } },
        h('div.export-check-label', null, label),
        desc ? h('div.faint', null, desc) : null,
      ),
    );
  }

  function savePreset(nameInp, verInp, opts) {
    exportPreset = {
      ...EXPORT_DEFAULTS,
      ...opts,
      packName: String(nameInp.value || '').trim(),
      packVersion: String(verInp.value || '').trim() || '1.0.0',
    };
    try { localStorage.setItem(EXPORT_PRESET_KEY, JSON.stringify(exportPreset)); } catch {}
    window.Toast.success('导出配置已保存');
  }

  function loadPreset() {
    try { exportPreset = { ...EXPORT_DEFAULTS, ...(JSON.parse(localStorage.getItem(EXPORT_PRESET_KEY) || '{}') || {}) }; } catch {}
    render(rootEl);
    window.Toast.info('已读取导出配置');
  }

  function openExportGuide() {
    let modal = null;
    modal = window.Modal.open({
      title: '整合包制作指南',
      body: (el) => el.append(
        h('div.col', { style: { gap: '10px', fontSize: '13px', lineHeight: '1.7' } },
          h('div', null, '1. 选择要导出的实例，填写整合包名称与版本。'),
          h('div', null, '2. 勾选导出内容：「Mod 设置与任务书」包含 config、defaultconfigs、ftbquests、patchouli_books、kubejs、scripts 等。'),
          h('div', null, '3. 「游戏本体」不用打包，导入时会按整合包元数据自动安装对应 MC 版本与加载器。'),
          h('div', null, '4. PCL 兼容 zip：CurseForge manifest + overrides 结构，PCL/HMCL/YMCL 能识别并自动安装游戏本体与加载器。'),
          h('div', null, '5. Modrinth 导出为 .mrpack，适合支持 Modrinth 格式的启动器。'),
          h('div.muted', null, '不会打包启动器程序、存档、日志、libraries、assets 或 natives。'),
        ),
      ),
      footer: [h('button.btn.btn-primary', { onclick: () => modal.close(true) }, '知道了')],
    });
  }

  async function exportFlow(sel, nameInp, verInp, opts) {
    const [dir, id] = String(sel && sel.value || '').split('|');
    if (!id) return window.Toast.warn('没有可导出的实例');
    const options = {
      ...opts,
      packName: String((nameInp && nameInp.value) || '').trim() || id,
      packVersion: String((verInp && verInp.value) || '').trim() || '1.0.0',
    };
    try {
      savePreset(nameInp, verInp, opts);
      const plan = await window.smcl.exportPlan(id, dir, options);
      plan.gameRoot = dir;
      const box = rootEl.querySelector('#exportPlanBox');
      window.Dom.clear(box).append(
        h('div.card.mt-12', null,
          h('div.card-body', null,
            h('div.row.row-wrap', null,
              h('span.badge.badge-blue', null, `实例 ${plan.id}`),
              h('span.badge', null, `名称 ${plan.packName || plan.id}`),
              h('span.badge', null, `版本 ${plan.packVersion || '1.0.0'}`),
              plan.mcVersion ? h('span.badge', null, `MC ${plan.mcVersion}`) : null,
              plan.loader ? h('span.badge.badge-purple', null, `${plan.loader} ${plan.loaderVersion || ''}`) : null,
              h('span.badge', null, `${plan.files.length} 个文件`),
              h('span.badge.badge-green', null, fmtSize(plan.totalBytes)),
              plan.questFiles > 0 ? h('span.badge.badge-orange', null, `任务书 ${plan.questFiles} 个文件`) : null,
            ),
            h('div.row.mt-12', { style: { flexWrap: 'wrap' } },
              h('button.btn.btn-primary.pressable', { onclick: () => doExport(plan, 'pcl') }, '导出整合包 zip（含任务书）'),
              h('button.btn.btn-ghost.pressable', { onclick: () => doExport(plan, 'mrpack') }, '导出 Modrinth (.mrpack)'),
            ),
          ),
        ),
      );
    } catch (err) {
      window.Toast.error(err.message.replace(/^Error: /, ''));
    }
  }

  async function doExport(plan, format = 'pcl') {
    try {
      const safeName = String(plan.packName || plan.id).replace(/[\/:*?"<>|]/g, ' ').trim() || plan.id;
      const dest = await window.smcl.exportPick(format === 'pcl' ? safeName + '-PCL' : safeName, format);
      if (!dest) return;
      window.Toast.info(format === 'pcl' ? '正在打包（含任务书）…' : '正在打包 Modrinth 整合包…');
      const r = await window.smcl.exportPack(plan.id, dest, plan.gameRoot, format, plan.options || {});
      const d = r.detected;
      window.Toast.success(d
        ? `已导出 ${r.count} 个文件 · ${d.format} · MC ${d.mcVersion || '?'}${d.loader ? ' · ' + d.loader + ' ' + (d.loaderVersion || '') : ''}`
        : `已导出 ${r.count} 个文件 → ${dest}`);
    } catch (e) {
      window.Toast.error(e.message.replace(/^Error: /, ''));
    }
  }

  window.Pages = window.Pages || {};
  window.Pages.packs = {
    render,
    onShow() {},
    // 供全局拖拽调用：直接进入预览流程
    importPath(file) { return pickPath(file); },
    onProgress(p) {
      const bar = document.getElementById('packBar');
      if (!bar) return;
      bar.style.width = `${p.percent || 0}%`;
      const msg = document.getElementById('packMsg');
      const pct = document.getElementById('packPct');
      if (msg) msg.textContent = p.message || '';
      if (pct) pct.textContent = p.percent != null ? `${p.percent}%` : '';
    },
  };
})();
