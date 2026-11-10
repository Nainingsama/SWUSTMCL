# 星启 SWUSTMCL

> 西南科技大学 Minecraft 启动器 —— Electron + 原生 HTML/CSS/JS（无前端框架），免安装、MIT 开源。

深色 / 浅色双主题 · 玻璃拟物（毛玻璃）· 卡片化 · 流畅动效，叠加在你自己的壁纸上。
开箱即用：解压双击，自动发现 PCL / HMCL 的游戏目录与已装实例。

![tech](https://img.shields.io/badge/Electron-45-47848F) ![license](https://img.shields.io/badge/License-MIT-green) ![platform](https://img.shields.io/badge/Windows-10%2F11-blue)

---

## 功能一览

| 模块 | 能力 |
| --- | --- |
| **首页** | 版本下拉 / 内存滑块（自动分配，跟随物理内存）/ 一键启动、Java/目录/实例/安全状态四宫格、公告与更新提示条 |
| **版本管理** | 跨目录汇总实例卡片：加载器徽章、版本隔离、模组数、**实际占用空间**；两行操作（启动 · MOD · 目录 / **体检** · 导出 · 删除到回收站）；**MOD 管理表格**（图标/名称/作者/版本/开关/删除/搜索，图标从 jar 内提取，无图标显示 MOD 字样）；**实例设置**（改名 / Java / 内存 / JVM 参数 / 隔离三态） |
| **下载游戏** | Mojang 清单**正式版 / 快照 / 旧版（Beta+Alpha）**筛选与搜索、逐行进度条、已安装可**重新安装**（增量补全）；Fabric / Quilt / Forge / NeoForge 在线安装（底座缺失自动补装，镜像竞速 + 自动重试） |
| **下载任务** | 独立页面：进行中 / 历史记录、搜索、来源筛选；右下角 PCL 式悬浮进度卡，切页不丢进度 |
| **整合包** | 导入 Modrinth / CurseForge / PCL·HMCL 裸目录 zip（拖拽或选择，自动识别四种格式 → 预览 → 重名自动改名 → 依赖校验）；导出为 Modrinth 格式 zip |
| **资源** | Modrinth 全功能 + CurseForge（填 Key 后并行聚合），模组/光影/材质包，按版本与加载器筛选、**中文译名搜索**（离线译名库 + MC百科桥接 + 自学习）、前置 Mod **自动补全并显示名称**、分页浏览 |
| **存档** | 跨目录扫描（含版本隔离实例），缩略图列表：世界名 / 版本 / 模式 / 最后游玩时间，按实例/版本/时间分组，定位与回收站 |
| **账户** | 多账户管理（SAUMCL 风格卡片网格 + 「＋ 添加角色」**弹窗**）：**微软正版设备码登录（无需注册 Azure）**、**多开离线账户**、**皮肤站登录（authlib-injector，支持拖拽 / 剪贴板 / Ctrl+V 导入 API 地址）**；皮肤导入（64x64 / 64x32 / 128 高清）+ 纸娃娃预览；点击卡片切换，登录成功自动刷新 |
| **设置** | 游戏存储位置（任意盘符）、内存自动分配 + **启动前自动优化** + 手动优化按钮、JVM 参数、**缺失 Java 自动下载**（清华 Adoptium 镜像）、下载源三档（智能选择/尽量镜像/尽量官方）、DoH 加速解析、**浅色/深色各一套壁纸**（铺满/完整/拉伸 + 5 种蒙版 + 不透明度/模糊/压暗/玻璃度）、主题色固定校徽蓝或跟随壁纸取色 |
| **更新** | GitHub Release 增量更新：体积 + SHA-256 + zip 结构三重校验，不覆盖安装；5 分钟版本巡查 + 系统通知 |

## 底层容错（硬核部分）

- **多启动器目录发现**：解析桌面/开始菜单 `.lnk` 快捷方式定位 PCL/HMCL/BakaXL 的 exe，取同级 `.minecraft`（适配 PCL 便携版布局）；盘符根两层浅搜兜底；隔离实例自动 `--gameDir` + 工作目录双指向。
- **自研 NBT 解析器**：Node `zlib` + 手写 Parser，TAG 1–12 全支持；只读 `level.dat` 绝不加载区块；兼容 1.21.2+ 的 `difficulty_settings.difficulty` 字符串结构；强制剥离 `§` 格式码（含 `§x` 十六进制色）。
- **双源竞速与增量安装**：版本清单 `Promise.any` 同时请求 BMCLAPI 与官方源；单文件下载失败自动换源；已存在且大小/哈希一致的文件直接跳过（重复安装不重复下载）；镜像返回错误页（HTML 冒充 jar）会被 zip 头校验拦截；大文件分片并发下载；源健康度统计自动优选。
- **DoH**：域名被污染时经阿里 DoH 解析 + IP 直连（SNI 保持），下载不再卡 DNS。
- **GPU 兼容兜底**：监听 `child-process-gone`，GPU 进程异常即写安全标记并带 `--no-sandbox --disable-gpu-sandbox` 自动重启；下次启动直接进兼容模式并禁用硬件加速。
- **第三方注入防护**：启动时检测并结束搜狗输入法云组件（SGTool / SogouCloud / 智能助手）——它们向新进程注入 DLL 会被 Chromium 判定非法而闪退。
- **实时版本检查**：后台每 5 分钟拉清单，最新正式版变化 → 界面提示条 + 系统通知（可在设置关闭）。

## 快速开始


> **国内下载慢？** 在下载链接前加加速前缀即可，例如：
> 
>     https://gh-proxy.com/https://github.com/Nainingsama/SWUSTMCL/releases/download/v1.1.0/SWUSTMCL-1.1.0-Setup-x64.exe
> 
> 也可把前缀换成 https://ghproxy.net/ ；启动器内置更新在直连卡住 12 秒后会自动切换镜像。

**直接使用**：下载 [Releases](https://github.com/Nainingsama/SWUSTMCL/releases) 里的 `SWUSTMCL-1.1.1-win-x64.zip`，解压到任意目录，双击 `SWUSTMCL.exe` —— 免安装，数据存在程序旁的 `userdata/`，删目录即卸载。

**从源码运行**（需要 Node.js 18+）：

```bash
npm install
npm start          # 开发运行
npm test           # 单元测试（NBT / 安全边界 / 双源回退 / 启动参数）
npm run build:win  # 打 Windows 免安装包 → dist/SWUSTMCL-<版本>-win-x64.zip
```

## 目录结构

```
main/
  main.js            主进程入口：窗口 / GPU兜底 / IPC 注册 / 5分钟版本巡查
  preload.js         contextBridge 白名单（无 nodeIntegration）
  core/
    safe.js          安全边界：版本名/路径穿越/URL白名单/zip条目
    net.js           下载（.part + SHA1/SHA256 + zip头校验）+ 并发池 + DoH + 源健康
    mirror.js        BMCLAPI 镜像改写规则
    versions.js      清单双源竞速 / 实例扫描 / 体积
    install.js       安装流水线（client jar / 库 / 资源 / natives / 完整性校验）
    repair.js        依赖体检与补全（含 jar 损坏检测）
    loaders.js       Fabric/Quilt/Forge/NeoForge 在线安装
    launch.js        启动参数构建（隔离 / natives 平铺 / JVM 消毒 / classpath 去重）
    java.js          Java 探测与版本挑选
    javainstall.js   缺失 Java 自动下载（清华 Adoptium 镜像 → 官方兜底）
    memory.js        内存优化（EmptyWorkingSet）
    dirs.js          快捷方式嗅探 / 多目录聚合 / 隔离检测
    nbt.js           自研 NBT 读取器（TAG 1-12）
    saves.js         存档扫描（level.dat + icon + 体积）
    auth.js          设备码登录（Live 免注册 / Azure 双通道）
    account.js       令牌续期（safeStorage 加密）/ 头像缓存 / 皮肤导入
    accountstore.js  多账户存储（safeStorage 加密）
    translation.js   离线译名库（内置 + 用户自学习）
    modpack.js       整合包解析 / 导入 / 导出
    content.js       Modrinth / CurseForge 搜索与安装（含中文译名桥接）
    updater.js       GitHub Release 增量更新
    wallpaper.js     smcl-wall:// 白名单协议 + 壁纸导入 + 主题取色
    gpu.js           GPU 兜底标记 + Windows 显卡偏好（注册表）
    settings.js      配置持久化 + 加密密钥存储
renderer/
  index.html         布局骨架（顶栏/侧栏/主区/日志抽屉）
  css/               设计体系（玻璃拟物 token、组件库、页面样式、双主题）
  js/                store（发布订阅）/ dom / toast / modal / theme / skinview
    pages/           home / versions / download / downloads / packs / content / saves / account / settings
scripts/build-win.js 免安装便携打包
test/                单元测试
```

## 安全模型

- `contextIsolation: true`，`nodeIntegration: false`，`sandbox: true`；
- 渲染层只能通过 preload 白名单 API 调用主进程，所有 IPC 参数二次校验；
- 路径拼接全程防目录穿越（`safeJoin` / `assertVersionId` / Windows 保留名拦截）；
- 下载校验 SHA1 / SHA256；`smcl-wall://` 协议只读 `userData/wallpapers/` 白名单文件名；
- 令牌经 `safeStorage`（Windows DPAPI）加密落盘；
- 渲染层导航全部阻断（防拖拽/注入劫持 preload API）。

## 免安装与数据位置

- **便携模式**：打包版把全部数据（配置、加密令牌、壁纸、缓存）放在程序目录旁的 `userdata/`，不写 %APPDATA%，删目录即卸载。
- **开发模式**（`npm start`）数据在 `%APPDATA%\SWUSTMCL`。

## 版本与更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)（MAJOR.MINOR.PATCH），所有变更记录在 [CHANGELOG.md](./CHANGELOG.md)（[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式）。

- **PATCH**（1.0.x）：Bug 修复、文案/样式微调
- **MINOR**（1.x.0）：向后兼容的新功能
- **MAJOR**（x.0.0）：不兼容变更（配置格式、数据目录结构等）

**每次发版的固定流程**：

1. `package.json` 的 `version` 改新版本号
2. 在 `CHANGELOG.md` 的 `[Unreleased]` 下整理变更，发版时改为 `[x.y.z] - YYYY-MM-DD`
3. `npm test` 全绿后 `npm run build:win`
4. 在 GitHub 创建同名 Tag（`vx.y.z`）的 Release，上传 `dist/SWUSTMCL-x.y.z-win-x64.zip`，Release 说明直接引用 CHANGELOG 对应段落
5. 客户端内置更新器会自动检查 `Nainingsama/SWUSTMCL` 的 Latest Release（增量校验后更新）

CHANGELOG 分类约定：`新增 Added` / `变更 Changed` / `修复 Fixed` / `移除 Removed` / `安全 Security`，面向用户描述行为变化，不写内部实现细节。

## 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 双击后无窗口、瞬间闪退 | **搜狗输入法**的云组件（SGTool / SogouCloud / 智能助手）向新进程注入 DLL，被 Chromium 的代码完整性检查判定为非法注入后主动崩溃 | 任务管理器结束 `SGTool.exe`、`SogouCloud.exe`、`SOGOUSmartAssistant.exe` 后再启动；或在搜狗输入法设置里关闭「云输入 / 智能助手 / 今日热搜」 |
| 启动后日志大量 `拒绝访问 (0x5)` | userData 缓存目录 ACL 损坏 | 启动时自动重置（改名重建）；手动法：删除 `userData` / `%APPDATA%\SWUSTMCL` |
| GPU 进程反复崩溃 | 驱动异常 / 安全软件拦截沙箱 | 启动器自动写入兼容标记并带 `--no-sandbox --disable-gpu-sandbox` 重启，无需手动处理 |
| 下载速度慢 / 卡住 | 镜像限速或域名被污染 | 设置 → 下载源切「尽量官方」或「智能选择」，开启 DoH |

## 致谢

架构与实现细节参考了 MIT 开源项目 **SMUCL**（上海海事大学）、**SJMCL**（上海交通大学）启动器，特此致谢。BMCLAPI 由 bangbang93 维护。

## License

[MIT](./LICENSE)
