# 星启 SWUSTMCL 实现说明

本文档面向维护者，说明模块划分、IPC 通道清单、动效实现、第三方依赖与底层容错逻辑。

## 1. 模块划分

### 主进程（main/）

| 模块 | 职责 | 关键点 |
| --- | --- | --- |
| `main.js` | 入口：窗口、GPU 兜底、IPC 注册、5 分钟版本巡查、自更新巡查 | 单实例锁；`will-navigate` 全阻断 |
| `core/safe.js` | 安全边界 | `assertVersionId`（单段版本名 + Windows 保留名）、`safeJoin`（逐段校验 + realpath 内含判定）、`safeEntryName`（zip 条目）、URL 主机白名单 |
| `core/net.js` | 网络层 | `.part` 临时文件先校验再改名；SHA1/SHA256；zip 头校验（拦镜像错误页）；`minBytes`；`noRetry` 标记内容级错误直接抛给上层换源；并发池 |
| `core/mirror.js` | 双源改写 | Mojang 六个 host → BMCLAPI；`resources.download.minecraft.net` → `/assets` 前缀，`libraries.minecraft.net` → `/maven` |
| `core/versions.js` | 清单与实例 | `Promise.any` 双源竞速；磁盘缓存断网兜底；`inheritsFrom` 三层继承合并（Maven 坐标去重，防 Forge `Duplicate key`）；`guessMcVersion`（`--fml.mcVersion` → 库坐标 → 实例名） |
| `core/install.js` | 安装流水线 | client jar / 库 / 资源索引 / 素材（hash 限 40 位十六进制防穿越）/ log4j 配置；natives 解压复用；pre-1.6 虚拟资源；安装后完整性校验 |
| `core/repair.js` | 依赖修复 | 按 JSON 核对体积 + jar 头损坏检测，缺的补、坏的删了重下 |
| `core/loaders.js` | 加载器 | Fabric/Quilt 直接 profile JSON；Forge/NeoForge 下载 installer.jar 用本机 Java `--installClient` 静默安装（按 MC 版本挑安装器 Java：1.17+ 用 21，1.13~1.16 用 8）；按产物判断成败 |
| `core/launch.js` | 启动 | 新旧参数格式兼容；JVM 消毒（剔除 `-javaagent` 等注入面）；classpath 大小写不敏感去重；natives 平铺到 `<实例>/natives`（PCL 的分层 natives 不能直接指）；隔离实例 `--gameDir` + cwd 双指向 |
| `core/java.js` | Java | 手动 > JAVA_HOME > PATH > 常见发行商目录 > 游戏内置 runtime；并发探测；版本挑选允许最多高 2 级（ASM class 版本上限），找不到明确失败 |
| `core/dirs.js` | 目录发现 | `.lnk` 双编码（UTF-16LE/ANSI）正则抽取目标 exe；桌面/开始菜单/公共桌面；盘符两层浅搜；`isIsolatedInstance`（mods/config/saves/options.txt/logs 标记） |
| `core/nbt.js` | NBT | TAG 1-12；gzip/zlib/原始三态；列表截断 512 防卡顿；`difficulty_settings.difficulty`（1.21.2+）；`§` 格式码剥离 |
| `core/saves.js` | 存档 | 三种存放位置；icon.png 限 256KB；体积递归限深 6；并发 3 |
| `core/auth.js` | 微软登录 | 双通道：Live（`00000000402b5328`，MBI_SSL，XBL 票据 `t=` 前缀）/ Azure v2（`d=` 前缀）；XBL→XSTS→MC 链路；XErr 错误码人话映射 |
| `core/account.js` | 账号存储 | 令牌 safeStorage(DPAPI) 加密；过期前 60s 自动续期；invalid_grant 降级离线；皮肤纹理缓存 6h（sessionserver 兜底）；本地皮肤尺寸校验 |
| `core/modpack.js` | 整合包 | 三格式清单 + PCL/HMCL 裸目录；`safeEntryName` 逐条过滤；SKIP_TOP 挡启动器数据；重名自动加序号；Modrinth 导出 |
| `core/content.js` | 资源 | Modrinth search/version/依赖递归补齐；CurseForge 走 x-api-key |
| `core/updater.js` | 自更新 | GitHub Releases；体积 + SHA-256（资产 digest 或发布说明行）+ zip 结构（必须含主程序与 resources）三重校验；解压到 staged → cmd 换装脚本（先整体挪到 previous 再 xcopy，非覆盖式） |
| `core/wallpaper.js` | 壁纸 | 图片复制进 userData（魔数嗅探真实类型）；`smcl-wall://local/<file>` 白名单协议；HSL 圆周平均取色（灰图回落校徽蓝） |
| `core/gpu.js` | 显卡偏好 | `HKCU\...\UserGpuPreferences` 写 javaw 路径；GBK 解码 reg.exe 输出 |

### 渲染层（renderer/）

- `js/store.js` —— 发布订阅状态机（`get/set/on`，支持通配）。
- `js/theme.js` —— 设置 → CSS 变量联动（accent / 壁纸层 / 玻璃不透明度）。
- `js/skinview.js` —— Canvas 手绘：8x8 头部（脸+帽子层）与 16x32 纸娃娃（64x64 overlay 层 + slim 支持）。
- `js/pages/*.js` —— 每页一个模块：`render(root)` + `onShow()` + 进度事件回调。
- 路由（`app.js`）：视图切换 = 旧页淡出上浮（140ms）→ 新页 `viewIn` 淡入上浮（280ms，`cubic-bezier(0.22,1,0.36,1)`）；`prefers-reduced-motion` 与手动开关时全部动画时长压到 0.01ms。

## 2. IPC 通道清单

`preload.js` 暴露命名空间 `window.smcl`：

| 分组 | 通道（invoke） | 说明 |
| --- | --- | --- |
| 应用 | `app:state` `app:info` | 全量状态 / 版本信息 |
| 窗口 | `win:minimize` `win:maximize` `win:close`（send） | 无边框窗口控制 |
| 设置 | `settings:save` + 事件 `settings:changed` | 白名单字段校验（内存/并发/来源/主题/壁纸五参数等） |
| 目录 | `dirs:list` `dirs:add` `dirs:remove` | 游戏目录聚合 |
| Java | `java:detect` | 并发探测 |
| 版本 | `versions:manifest` `versions:installed` `versions:sizes` `version:command` `version:delete` | 清单/实例/体积后台补齐/复制命令/回收站 |
| 安装 | `install:start` `game:repair` + 事件 `install:progress` | 单实例互斥（busy 标记） |
| 启动 | `game:launch` `game:kill` `game:copyCommand` `game:openLog` + `game:started/exit/error` | 令牌续期 → Java 挑选 → spawn |
| 存档 | `saves:list` `saves:reveal` `saves:trash` + `saves:progress` | shell.trashItem |
| 加载器 | `loader:list` `loader:install` + `loader:progress` | 底座自动补装 |
| 整合包 | `modpack:pick/inspect/install` `pack:exportPlan/exportPick/export` + `modpack:progress` `pack:exportProgress` | |
| 资源 | `content:search/versions/install` + `content:progress` | |
| 账号 | `auth:status/login/logout`（cancel 为 send）`avatar:get` `skin:import/clear/local` + `auth:stage/done/failed` | 设备码阶段推送 |
| 壁纸 | `wallpaper:pick/clear/palette` | 返回取色结果 |
| 显卡 | `gpu:applyAll` | 批量写注册表 |
| 更新 | `update:check` `update:install` + `update:available/progress/changelog` `manifest:latest` | |
| 日志 | `log:recent` `log:clear`（send）+ `game:log` `game:log:cleared` | 环形缓冲 2000 行 |

## 3. 动效实现方案

- **页面切换**：`viewOut`（淡出+上浮 8px，160ms）→ DOM 切 active → `viewIn`（淡入+上浮 14px→0，280ms）。两段动画都是 `transform: translateY` + `opacity`（合成层属性，不触发重排）。
- **卡片悬浮**：`translateY(-3px)` + 阴影加深（`--shadow-hover`）；**按压回弹**：`:active { transform: scale(0.977) }`，松手由 `cubic-bezier(0.22,1,0.36,1)` 曲线弹回。
- **进度条**：宽度变化只改 `style.width`，CSS `transition: width .25s cubic-bezier(.3,.7,.4,1)` 负责插值，主进程 180ms 节流推送。
- **启动按钮**：hover 扫光（`::after` 渐变 translateX）、busy 时 spinner 旋转。
- **抽屉**：`height 34px ↔ 240px` 过渡；日志错误行时红点发光（`box-shadow` 动画）。
- **无障碍**：`prefers-reduced-motion: reduce` 与 `body.reduce-motion` 双通道，把动画/过渡压到 0.01ms。

## 4. 第三方依赖与许可证

| 依赖 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| electron | ^33（随安装最新稳定） | MIT | 运行时 |
| adm-zip | ^0.5.16 | MIT | zip 读取/写入（natives 解压、整合包、更新包） |

其余全部为 Node/Electron 内置或手写：fetch（Node 内置）、zlib（NBT）、`crypto`（哈希）、`safeStorage`（令牌加密）、Canvas（皮肤）、`nativeImage`（取色）。未引入 React/Vue/NBT 库/取色库/请求库。

## 5. 底层容错逻辑

### 5.1 路径嗅探（多启动器兼容）

1. 扫桌面、开始菜单、公共桌面的 `*craft*|*pcl*|*hmcl*|*bakaxl*|*minecraft*.lnk`；
2. `.lnk` 是二进制 Shell Link：对原始字节分别跑 `utf16le` 与 `latin1` 解码，用正则 `[A-Za-z]:\\[...]{3,120}` 抽取目标路径（两种编码互为冗余）；
3. 命中 exe 存在 → 其同级目录视为启动器根；PCL 便携版布局（exe 与 `.minecraft` 同级、不在 %APPDATA%）由此覆盖；
4. 兜底：C/D/E 盘根目录两层浅搜已知 exe 名；`%APPDATA%\.minecraft` 恒在列表；
5. 去重后逐目录扫描 `versions/`，`isIsolatedInstance` 以 mods/config/saves/options.txt/logs 任一存在判定隔离。

### 5.2 双源竞速与增量安装

- 清单：`Promise.any([BMCLAPI, Mojang])`，9 秒超时，谁先用谁；双方全挂 → 磁盘缓存（6 小时内）兜底展示。
- 单文件：主源（设置可选）失败 → 自动换备用源；内容级错误（HTML 错误页 / 假 zip）标记 `noRetry` 不再重试同源，直接换源。
- 增量：下载前按「大小一致 → SHA1/SHA256 一致 → zip 头有效」三级判断跳过；不一致删掉重下；`.part` 临时文件校验通过才改名。

### 5.3 GPU 兜底

1. `app.on('child-process-gone')` 过滤 `type === 'GPU'` 且 reason 非正常退出；
2. 写标记 `settings.gpuFallback = true`（即"安全标记"，持久化在配置文件）；
3. `app.relaunch(['--no-sandbox', '--disable-gpu-sandbox', '--disable-gpu-compositing', '--swustmcl-gpu-fallback'])` + `app.exit(0)`；
4. 下次启动读到标记 → `app.disableHardwareAcceleration()` 直接以兼容模式运行（不再二次重启循环）。

### 5.4 安全设计要点

- 版本 JSON / 清单 / Modrinth 响应里的每个路径都过 `safeJoin`/`safeEntryName`（`../`、盘符、控制字符全拒）；
- 资源哈希必须是 40 位十六进制才能参与路径拼接；
- 版本名禁止 Windows 保留设备名（con/com1...）与首尾点空格；
- `versions:install` 等写操作用 `busy` 表做单飞互斥；
- 删除操作走系统回收站（`shell.trashItem`）而非直接 unlink。
