'use strict';
/**
 * 主题联动：把设置（壁纸 + 主题色 + 玻璃参数）应用到 DOM。
 * 主题色优先级：accent=brand → 固定校徽蓝；accent=wallpaper → 主进程从壁纸
 * 取的主色（纯灰图主进程已回落校徽蓝）。
 */
(function () {
  const BRAND_BLUE = '#1668dc';
  const DEFAULT_WALLPAPER = 'assets/default-wallpaper.png'; // 深色夜间出厂背景（19:00-08:00）
  const DEFAULT_WALLPAPER_DAY = 'assets/default-wallpaper-day.png'; // 深色白天出厂背景（08:00-19:00）
  const DEFAULT_WALLPAPER_LIGHT = 'assets/default-wallpaper-light.png'; // 浅色出厂背景（篝火草原）

  /** 夜间：19:00 - 次日 08:00 */
  function isNightTime(now = new Date()) {
    const h = now.getHours();
    return h >= 19 || h < 8;
  }

  /** 深色主题的出厂默认壁纸：白天/夜间自动切换 */
  function defaultDarkWallpaper() {
    return isNightTime() ? DEFAULT_WALLPAPER : DEFAULT_WALLPAPER_DAY;
  }

  let frontIsA = true; // 双层交叉淡入：当前前台层
  let currentSrc = '';
  let rotationTimer = null;

  function userSrc(name) {
    return name ? `smcl-wall://local/${encodeURIComponent(name)}` : '';
  }

  /** 解析当前应显示的壁纸：轮换模式按时间取第 N 张；昼夜模式按时间取白天/夜间 */
  function resolveWallpaperSrc(wp, theme) {
    const isLight = theme === 'light';
    const mode = wp.mode === 'slideshow' ? 'slideshow' : 'daynight';
    if (mode === 'slideshow') {
      const imgs = (wp.images || []).filter(Boolean);
      if (imgs.length) {
        const interval = Math.max(1, Number(wp.intervalMin) || 10) * 60000;
        const idx = Math.floor(Date.now() / interval) % imgs.length;
        return userSrc(imgs[idx]);
      }
    }
    if (isLight) return userSrc(wp.imageLight || '') || DEFAULT_WALLPAPER_LIGHT;
    if (mode === 'daynight') {
      const night = isNightTime();
      const u = userSrc(night ? (wp.nightImage || wp.image || '') : (wp.dayImage || ''));
      return u || (night ? DEFAULT_WALLPAPER : DEFAULT_WALLPAPER_DAY);
    }
    return userSrc(wp.image || '') || DEFAULT_WALLPAPER;
  }

  function scheduleRotation(wp, theme) {
    if (rotationTimer) { clearInterval(rotationTimer); rotationTimer = null; }
    if (!wp || wp.mode !== 'slideshow' || !(wp.images || []).length || !wp.enabled) return;
    rotationTimer = setInterval(() => {
      const st = window.Store && window.Store.state && window.Store.state.settings;
      if (!st) return;
      const next = resolveWallpaperSrc(st.wallpaper || {}, st.theme);
      if (next !== currentSrc) applyWallpaper(st.wallpaper || {}, st.theme);
    }, 30000);
  }

  function applyWallpaper(wp, theme) {
    const layer = document.getElementById('wallpaper');
    const imgA = document.getElementById('wallpaperImg');
    const imgB = document.getElementById('wallpaperImg2');
    const mask = document.getElementById('wallpaperMask');
    const isLight = theme === 'light';
    if (!wp || (!wp.enabled && !wp.image && !wp.imageLight && !wp.dayImage && !wp.nightImage && !(wp.images || []).length)) {
      layer.hidden = true;
      return;
    }
    layer.hidden = false;
    const src = resolveWallpaperSrc(wp, theme);
    const fitCls = `wallpaper-img fit-${['cover', 'contain', 'stretch'].includes(wp.fit) ? wp.fit : 'cover'}`;
    const opacity = String(wp.opacity);
    if (!imgB) {
      // 兼容旧结构：单层直接替换
      imgA.style.backgroundImage = `url("${src}")`;
      imgA.className = fitCls;
      imgA.style.opacity = opacity;
      currentSrc = src;
    } else if (src !== currentSrc) {
      const front = frontIsA ? imgA : imgB;
      const back = frontIsA ? imgB : imgA;
      back.style.transition = 'none';
      back.style.opacity = '0';
      back.style.backgroundImage = `url("${src}")`;
      back.className = fitCls;
      void back.offsetWidth; // 强制回流，确保从 0 开始淡入
      back.style.transition = '';
      back.style.opacity = opacity;
      front.style.transition = '';
      front.style.opacity = '0';
      currentSrc = src;
      frontIsA = !frontIsA;
      setTimeout(() => { front.style.opacity = '0'; front.style.backgroundImage = 'none'; }, 1000);
    } else {
      (frontIsA ? imgA : imgB).style.opacity = opacity;
    }
    try {
      const key = isLight ? 'swustmcl.wallpaper.light' : 'swustmcl.wallpaper.dark';
      localStorage.setItem(key, src); // 秒显缓存：上次实际显示的图
      localStorage.setItem('swustmcl.theme', isLight ? 'light' : 'dark');
    } catch {}
    mask.className = `wallpaper-mask mask-${['none', 'soft', 'top', 'bottom', 'vignette'].includes(wp.mask) ? wp.mask : 'soft'}`;
    // blur 时放大图片边缘防白边
    document.documentElement.style.setProperty('--wall-opacity', String(wp.opacity));
    document.documentElement.style.setProperty('--wall-blur', `${wp.blur}px`);
    document.documentElement.style.setProperty('--wall-blur-scale', wp.blur > 0 ? String(wp.blur / 40 + 0.02) : '0');
    document.documentElement.style.setProperty('--wall-dim', String(wp.dim));
    document.documentElement.style.setProperty('--glass-ui', String(wp.ui));
    // 浅色主题的内容区轻纱跟随不透明度反向伸缩：图片越实，纱越薄，滑杆才有直观效果
    const veil = 0.13 + (1 - Math.min(1, Math.max(0, Number(wp.opacity) || 0.6))) * 0.3;
    document.documentElement.style.setProperty('--wall-veil', String(veil));
    scheduleRotation(wp, theme);
  }

  function applyAccent(settings, wallpaperTheme) {
    let accent = BRAND_BLUE;
    let accent2 = '#4b8df0';
    if (settings.accent === 'wallpaper' && wallpaperTheme) {
      const pal = settings.theme === 'light' ? wallpaperTheme.light : wallpaperTheme.dark;
      accent = pal.base;
      accent2 = pal.base2;
    } else if (settings.accent === 'brand' && settings.theme === 'light') {
      accent = '#0f56bb';
      accent2 = '#3a7de0';
    }
    const root = document.documentElement.style;
    root.setProperty('--accent', accent);
    root.setProperty('--accent-2', accent2);
    // 计算 soft：hex → rgba
    const n = parseInt(accent.slice(1), 16);
    root.setProperty('--accent-soft', `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 0.18)`);
    root.setProperty('--accent-text', settings.theme === 'light' ? '#0f56bb' : '#dbe8ff');
    document.body.classList.toggle('theme-light', settings.theme === 'light');
    // 顶栏 / 底部日志条文字：跟随主题；若壁纸可测亮度，则按壁纸明暗选深/浅字
    const wp = settings.wallpaper || {};
    const lum = wallpaperTheme && wallpaperTheme.lum != null ? wallpaperTheme.lum : null;
    const lightTheme = settings.theme === 'light';
    // 背景是亮的吗？：浅主题恒亮；深主题看壁纸亮度（未取色时按深底处理）
    const brightBg = wp.enabled && lum != null ? lum > 0.5 : lightTheme;
    const chromeText = brightBg ? '#141a24' : '#f2f5fa';
    root.setProperty('--chrome-text', chromeText);
    root.setProperty('--chrome-text-dim', brightBg ? 'rgba(20, 26, 36, 0.68)' : 'rgba(232, 237, 245, 0.66)');
    root.setProperty('--chrome-bg', brightBg ? 'rgba(255, 255, 255, 0.62)' : 'rgba(10, 14, 22, 0.55)');
  }

  function applyAll(settings, wallpaperTheme) {
    if (!settings) return;
    applyWallpaper(settings.wallpaper, settings.theme);
    applyAccent(settings, wallpaperTheme);
    document.body.classList.toggle('reduce-motion', window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // 到 08:00 / 19:00 自动换默认壁纸（有自定义壁纸时也走一遍，逻辑无副作用）
  let dayNightTimer = null;
  function scheduleDayNight() {
    if (dayNightTimer) clearTimeout(dayNightTimer);
    const now = new Date();
    const next = new Date(now);
    if (now.getHours() < 8) next.setHours(8, 0, 0, 0);
    else if (now.getHours() < 19) next.setHours(19, 0, 0, 0);
    else { next.setDate(now.getDate() + 1); next.setHours(8, 0, 0, 0); }
    dayNightTimer = setTimeout(() => {
      try {
        const st = window.Store && window.Store.state && window.Store.state.settings;
        if (st) applyAll(st, window.Store.get('wallpaperTheme'));
      } catch {}
      scheduleDayNight();
    }, Math.max(5000, next.getTime() - now.getTime() + 1500));
  }
  scheduleDayNight();

  window.Theme = { applyAll, applyAccent, applyWallpaper };
})();
