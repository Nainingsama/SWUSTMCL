'use strict';
/**
 * 皮肤绘制：8x8 头部（含帽子层）头像 + 正面纸娃娃。
 * 全部基于 Canvas 手绘，无需第三方库。
 */
(function () {
  function loadSkin(dataUrl) {
    return new Promise((resolve, reject) => {
      if (!dataUrl) return reject(new Error('no skin'));
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('skin load failed'));
      img.src = dataUrl;
    });
  }

  /**
   * PCL 风格大头贴：头部 8x8（含帽子层）+ 底部 8x2 肩条（身体顶部）。
   * 逻辑画布 8x10，CSS 拉伸显示。
   */
  async function drawBust(canvas, dataUrl, opts = {}) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!dataUrl) return false;
    let img;
    try {
      img = await loadSkin(dataUrl);
    } catch {
      return false;
    }
    const s = img.height / 64;
    canvas.width = 8;
    canvas.height = 10;
    ctx.imageSmoothingEnabled = false;
    // 肩条：身体正面顶部 2px（源 20,20 起）
    ctx.drawImage(img, 20 * s, 20 * s, 8 * s, 2 * s, 0, 8, 8, 2);
    // 脸
    ctx.drawImage(img, 8 * s, 8 * s, 8 * s, 8 * s, 0, 0, 8, 8);
    // 帽子层
    ctx.drawImage(img, 40 * s, 8 * s, 8 * s, 8 * s, 0, 0, 8, 8);
    return true;
  }

  /**
   * 头像：8x8 脸 + 帽子层 8x8。
   * 源坐标：64x64 皮肤的标准坐标 = 图像像素；高清皮肤按 img.height/64 等比放大。
   */
  async function drawHead(canvas, dataUrl, { hat = true, flipX = false } = {}) {
    // Minecraft 标准头部 UV：第一层 (8,8,8,8)，第二层/帽子 (40,8,8,8)
    const N = 8; // 原生 8x8，显示层最近邻放大
    canvas.width = N;
    canvas.height = N;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, N, N);
    if (!dataUrl) return false;
    let img;
    try {
      img = await loadSkin(dataUrl);
    } catch {
      return false;
    }
    const s = img.width / 64;
    if (!s) return false;
    ctx.save();
    if (flipX) {
      ctx.translate(N, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(img, 8 * s, 8 * s, 8 * s, 8 * s, 0, 0, N, N);
    if (hat) ctx.drawImage(img, 40 * s, 8 * s, 8 * s, 8 * s, 0, 0, N, N);
    ctx.restore();
    return true;
  }

  async function drawDoll(canvas, dataUrl, opts = {}) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!dataUrl) return false;
    let img;
    try {
      img = await loadSkin(dataUrl);
    } catch {
      return false;
    }
    const srcScale = img.height / 64; // 源像素换算：64x64 → 1，128x128 → 2
    const scale = 12; // 目标放大倍数（逻辑坐标 16x32 → 画布）
    canvas.width = 16 * scale;
    canvas.height = 32 * scale;
    ctx.imageSmoothingEnabled = false;

    const armW = opts.slim ? 3 : 4;
    const hd = img.height >= 64; // 64x64 才有独立的左臂/左腿
    // blit(srcX, srcY, w, h, destX, destY) —— 源为皮肤标准坐标，dest 为逻辑坐标
    const blit = (sx, sy, w, h2, dx, dy) => {
      ctx.drawImage(
        img, sx * srcScale, sy * srcScale, w * srcScale, h2 * srcScale,
        dx * scale, dy * scale, w * scale, h2 * scale
      );
    };

    // 右臂（观感上在画面左侧）
    blit(44, 20, armW, 12, 0, 8);
    if (hd) blit(36, 52, armW, 12, 16 - armW, 8); // 左臂
    else blit(44, 20, armW, 12, 16 - armW, 8);    // 旧皮肤镜像右臂
    blit(20, 20, 8, 12, 4, 8);        // 身体
    blit(8, 8, 8, 8, 4, 0);           // 头
    blit(4, 20, 4, 12, 4, 20);        // 右腿
    if (hd) blit(20, 52, 4, 12, 8, 20); // 左腿
    else blit(4, 20, 4, 12, 8, 20);

    // overlay 层（64x64 专属）
    if (hd) {
      blit(40, 8, 8, 8, 4, 0);        // 帽子
      blit(20, 36, 8, 12, 4, 8);      // 外套
      blit(44, 36, armW, 12, 0, 8);   // 右袖 overlay
      blit(52, 52, armW, 12, 16 - armW, 8); // 左袖 overlay
      blit(4, 36, 4, 12, 4, 20);      // 右裤 overlay
      blit(4, 52, 4, 12, 8, 20);      // 左裤 overlay
    }
    return true;
  }

  window.SkinView = { drawHead, drawBust, drawDoll };
})();
