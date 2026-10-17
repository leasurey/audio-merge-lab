# 录音合并器（Audio Merge Lab）

纯本地、跨 iOS / Android / Web 的录音合并工具。一套前端代码，三端运行（浏览器 / PWA / Capacitor 原生壳）；所有音频处理都在设备本地完成，不上传任何数据。

- 版本：**V0.3.3**（版本唯一权威值见 `src/audio-core.js` 的 `APP_VERSION`）
- 作者：**k** · [B 站主页](https://space.bilibili.com/527557440)
- 目标平台：iOS Safari / Android Chrome / 桌面浏览器（PWA 可安装）
- 界面语言：中文
- 在线体验：https://audio-merge-lab.app.workbuddy.host/

---

## 快速开始

```bash
# 本地直接打开（导入/合并/MP3 可用；录音需要 localhost 或 HTTPS）
open dist/index.html

# 本地起服务（手机连同一 Wi-Fi 访问，可完整体验录音）
python -m http.server 8000
# 手机浏览器访问 http://<电脑IP>:8000/dist/

# 开发：修改 src/ 后重新构建（单文件 HTML + PWA 资源 + 图标）
node tools/build.js

# 测试（28 项）
npm test
python test/verify_wav.py   # Python wave 模块交叉校验 WAV 产物
```

> `dist/` 为构建产物，不随仓库分发（见 `.gitignore`）。首次使用先执行一次 `node tools/build.js`。

## 功能

- 导入 mp3 / m4a / wav / webm / ogg / flac（支持多选）
- **即时导入反馈**：选中文件立刻在列表显示「解码中」，队列顺序解码逐条汇报；点导入时即预热音频管线（藏在文件选择器打开的等待里）
- 内置录音：自动按平台优选编码（iOS → mp4/aac，Android → webm/opus）
- 片段试听、排序（上移/下移）、移除、清空
- 片段间隔 0–3 秒可调；可选峰值归一化（默认 8 倍增益上限）
- **三种输出格式**：WAV（16bit 无损，采样率自适应）/ MP3（lamejs，96–320 kbps，分块编码 + 进度 + 取消）/ M4A(AAC)（MediaRecorder 实时，耗时与音频等长）
- 底部常驻操作栏：段数、合计时长、预计体积实时汇总
- 结果试听、系统分享（Web Share API；iOS 自动降级为新窗口打开）
- PWA：可添加到主屏、离线可用

## 使用指南

> 网页版同类指南见 [`guide.html`](guide.html)（部署后为 `/guide.html`），
> 格式转换指引见 [`convert.html`](convert.html)，终端用户手册见 [使用说明.md](使用说明.md)。

### 三步完成合并

1. **添加片段** —— 点「导入音频文件」可多选（mp3 / m4a / wav / webm / ogg / flac），或点「开始录音」现录一段。
   手机录音一般是 m4a，与导入文件混在一起合并没有问题。
2. **调整顺序** —— 每条左侧 ▶ 试听，右侧 ↑ ↓ 调整先后，✕ 移除；底部实时显示段数与合计时长。
3. **选格式并合并** —— 点底部「合并为 XX」，进度走完 → 试听 → 「分享 / 下载」。

### 输出格式怎么选

| 格式 | 特点 | 适合 |
|---|---|---|
| **WAV**（推荐） | 无损，约 10 MB/分钟；合并几乎瞬间完成 | 存档、还要再剪辑、音质优先 |
| **MP3** | 体积约为 WAV 的 1/10；编码耗时（10 分钟音频约 1–2 分钟），可取消 | 发给别人、上传平台 |
| **M4A** | 体积小；实时编码，耗时与音频等长，需保持页面在前台 | 苹果生态兼容 |

### 导入失败时怎么办

| 提示 | 含义 | 处理 |
|---|---|---|
| 列表标注「内置解码」 | 平台解码器不支持，已用内置解码器（WAV 解析 / mpg123）救回 | 无需处理，可直接合并 |
| 检测为 **AMR** | 手机通话录音常见格式，浏览器均不支持 | 按 [convert.html](convert.html) 转 MP3 |
| 检测为 **SILK** | 微信语音私有编码 | 用 silk-v3-decoder 等专用工具导出 |
| 检测为 **WMA / APE / CAF** | 浏览器不支持 | 转 MP3 或 WAV |
| 点导入无反应 / 选择器无文件 | 部分国产内核对 `accept` 过滤有 bug | 点「用兼容模式选择（不过滤格式）」 |
| 白屏 / 「应用没能正常启动」 | 内核过旧（不支持 async/await，需 Chromium 55+ / iOS 11+） | 升级浏览器；打开 [`compat.html`](compat.html) 自检 |

## 目录结构

```text
├─ src\
│   ├─ audio-core.js       核心逻辑（纯函数，UMD）：PCM 归一/重采样/拼接/归一化/WAV/MP3 编码
│   │                       ← APP_VERSION 单一权威值在此
│   ├─ app.js              UI 层：导入、录音、试听、多格式合并、导出分享
│   ├─ styles.css          深色主题、移动端优先样式
│   ├─ manifest.webmanifest  PWA 清单
│   ├─ sw.js               Service Worker（离线缓存，仅真实 http(s) 部署时注册）
│   └─ vendor\lame.min.js  MP3 编码器（官方文件，SHA-1 已校验，见 THIRD-PARTY-NOTICES.md）
├─ index.template.html     页面骨架（含 /*VENDOR*/ /*STYLES*/ /*CORE*/ /*APP*/ 占位符）
├─ tools\
│   ├─ build.js              构建：内联为单文件 dist/index.html + 复制 PWA 资源 + 生成 PNG 图标
│   ├─ github-create-repo.js 维护者工具：用本机 Edge 会话经网页 UI 创建 GitHub 仓库
│   ├─ github-push.js        维护者工具：Git Data API 推送（历史方案，已被 git push 取代，留档）
│   └─ github-debug-page.js  维护者工具：浏览器页面结构诊断（选择器调试）
├─ test\                   单元测试 + MP3 功能测试 + Python 交叉校验脚本
├─ capacitor.config.json   Capacitor 配置（webDir 指向 dist）
├─ package.json            构建/测试脚本 + Capacitor 8.5.3 依赖声明
├─ LICENSE                 MIT + 附加声明
├─ THIRD-PARTY-NOTICES.md  第三方组件声明
├─ CHANGELOG.md            版本变更记录
├─ 使用说明.md             面向终端用户的中文使用指南
└─ README.md
```

## 合并管线

```text
文件/录音 → decodeAudioData（mp3/m4a/webm → PCM）
        → conformPcm（统一 44.1kHz + 立体声）
        → concatSegments（顺序拼接 + 间隔 + 淡变 + 可选归一化）
        → encodeWav / encodeMP3(lamejs) / encodeM4A(MediaRecorder 实时)
        → Blob → 试听/分享/下载
```

**为什么先解码再拼接**：压缩音频直接拼字节流，只有在各段编码参数（采样率、声道、码率）完全一致时才安全。录音文件参数各异，走 PCM 是唯一稳妥路线。

## 第三方致谢与来源声明

本项目的代码实现为原创，但建立在以下社区成果之上：

| 来源 | 使用内容 | 使用方式 |
|---|---|---|
| [zhuker/lamejs](https://github.com/zhuker/lamejs) | MP3 编码器 `lame.min.js` | 原样内联于 `src/vendor/` 与构建产物；git blob SHA-1 已与官方仓库校验；LGPL-3.0，详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) |
| [ffmpegwasm/ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm)、[arthenica/ffmpeg-kit](https://github.com/arthenica/ffmpeg-kit) | 调研过的替代转码方案 | 仅技术调研，未采用（前者体积大，后者已退役） |
| [ionic-team/capacitor](https://github.com/ionic-team/capacitor) | Web → iOS/Android 打包 | 工程配置与文档已就绪 |

**AI 辅助声明**：本项目开发过程中使用了 AI 编程助手辅助（AI-assisted development）。

## 许可证

见 [LICENSE](LICENSE)（MIT）。附加声明：MIT 仅覆盖本项目原创代码；`src/vendor/lame.min.js` 按上游 LGPL-3.0 处理；`dist/` 为构建产物不入库。

## 系统限制与"绕法"

先说边界：**越狱、私有 API、沙箱逃逸、审核绕过，这些不做**。下面全部是系统允许的正规工程手段。核心思路是——与其绕过沙箱去读别的 App 的文件，不如让合并只发生在自己家里的文件上。

### iOS

1. **沙箱隔离**：拿不到"语音备忘录"等 App 的文件。正规通道是文件 App（UIDocumentPicker）和分享菜单（UIActivityViewController / Share Extension）。本 App 的产品设计即"自录自合"：录音和合并在同一个 App 内完成，从根上消除跨 App 读取需求。
2. **后台持续录音**：声明 `audio` background mode + `AVAudioSession(playAndRecord)`。这是系统公开能力，不是漏洞。
3. **m4a/AAC 解码**：AVFoundation 原生支持；Web 侧用 `decodeAudioData`。
4. **Web 侧无法离线快速编码 AAC**：M4A 走 MediaRecorder 实时捕获（iOS Safari 14.3+ 支持 audio/mp4 录制）；要离线快速输出需原生 `AVAssetWriter`（Capacitor 插件）。

### Android

1. **分区存储（Scoped Storage）**：用 SAF（`ACTION_OPEN_DOCUMENT`）/ MediaStore。不要申请 `MANAGE_EXTERNAL_STORAGE`——那个才是"绕"，且直接影响上架审核。
2. **后台录音**：前台服务 + 通知（Android 14+ 需 `foregroundServiceType="microphone"`）。
3. **厂商 ROM 后台限制**：引导用户在系统设置里授权，属于用户知情操作。

### 导入外部录音的正路（后续）

- 用户在"语音备忘录/录音机"里点**分享** → 本 App（Share Extension 接收）；
- PWA 的 **Web Share Target**：Android 完整支持，iOS 16+ 有限支持。

## 打包为 iOS / Android App（Capacitor）

工程文件已就绪（`capacitor.config.json` + `package.json` 依赖）。在有网络的机器上执行：

```bash
npm install                 # 安装 Capacitor 8.5.3
npm run build               # 生成 dist/
npx cap add android         # 首次：生成 android/ 工程
npx cap add ios             # 首次：生成 ios/ 工程（需要 macOS + Xcode）
npm run cap:sync            # 每次构建后同步 Web 资源到原生工程
npm run cap:open:android    # 用 Android Studio 打开
npm run cap:open:ios        # 用 Xcode 打开
```

**必须手动添加的原生配置**（`cap add` 不会自动加）：

Android（`android/app/src/main/AndroidManifest.xml`）：

```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
```

iOS（`ios/App/App/Info.plist`）：

```xml
<key>NSMicrophoneUsageDescription</key>
<string>需要麦克风权限来录制要合并的音频</string>
```

iOS 后台持续录音：Xcode → Signing & Capabilities → Background Modes → 勾选 "Audio, AirPlay, and Picture in Picture"。

注意：Capacitor 的 WKWebView 里 `a[download]` 行为与浏览器不同，导出文件建议后续接 `@capacitor/filesystem` + `@capacitor/share` 插件（当前原型以浏览器分享/下载为主）。

## 已知限制（如实说明）

- 导入解码耗时取决于浏览器原生解码器（实测约 1–2ms/秒音频 + 约 0.5 秒固定开销）；V0.2.1 已做预热与即时占位反馈，但解码本体快不过系统解码器
- **长音频合并的内存下限是"已解码输入"本身**：V0.3.0 起合并输出走流式（OPFS 落盘优先，不支持则内存拼接并弹窗警告），输入逐段释放，峰值从"输入 + 输出 + 中间拷贝"降到接近"单段输入"；但不支持 OPFS 的旧浏览器上，几十分钟的合并仍可能触发浏览器内存上限（表现为页面重载）——这是浏览器限制，代码只能缓解不能消除
- M4A 输出是**实时**的：耗时与音频等长，且依赖浏览器 mp4 录制能力（不支持时该选项自动隐藏）
- `decodeAudioData` 对 m4a 的支持依赖平台解码器：iOS Safari 原生支持；Android Chrome 一般支持；**桌面 Chrome 不支持 AAC**。需真机验证
- MP3 编码在主线程分块执行（每块间让出），长文件耗时仍较明显（10 分钟音频约需 1–2 分钟）
- 未做裁剪、变速、交叉淡入淡出；只做顺序拼接 + 间隔 + 淡变 + 归一化
- `dist/` 不随仓库分发，克隆后需自行 `node tools/build.js` 生成

## 兼容性（Android 生态）

### 语法基线

产物脚本使用 **ES2017**（async/await），对应最低内核：Chromium 55+ / iOS 11+。启动守卫 `src/boot-guard.js` 与自检页 `compat.html` 是纯 **ES5**，保证旧内核也能显示可读提示而不是白屏。

验证方式（构建后执行，见下节命令）：用 acorn 以 `ecmaVersion: 2017` 解析产物脚本、以 `ecmaVersion: 5` 解析守卫与自检页——任何超线语法直接报错。

### 主流 Android 浏览器矩阵

| 浏览器 | 内核基础 | 已知问题 | 本项目应对 |
|---|---|---|---|
| Chrome / Edge / Firefox | Chromium / Gecko，持续更新 | 无 | 基准平台 |
| 三星浏览器 | Chromium | 无 | 基准平台 |
| 夸克 | UC U4（Chromium 内核） | 自有网络栈（HTTPDNS/云加速）对陌生域名偶发「网页打不开」 | 提供第二入口 + `compat.html` 自检 |
| UC 浏览器 | UC U4 / U3 | accept 过滤异常、云加速拦截 | 兼容模式导入入口（无 accept） |
| QQ 浏览器 / 微信内置 | X5（TBS） | accept 过滤异常；旧设备内核可能低至 Chromium 53（不支持 async/await） | 兼容模式导入 + 启动守卫提示「内核过旧」 |
| 华为 / 荣耀浏览器 | 自有内核（Chromium 系） | 无已知问题 | — |
| vivo / 小米 / OPPO 浏览器 | Chromium 系 | 通知栏下载入口差异 | 导出走 Web Share → 下载兜底 |
| 百度 / 360 浏览器 | Chromium 系 | accept 过滤偶发异常 | 兼容模式导入 |

> 说明：上表基于各浏览器的公开内核信息与已知社区问题整理；**未在真机上逐台验证**（本仓库开发环境无 Android 设备）。`compat.html` 的作用正是让用户一条链接跑出该设备的真实能力报告。

### 解码降级链（V0.3.2）

平台 `decodeAudioData` 在部分环境会失败（Android 厂商内核、桌面 Chrome 的 AAC、带异常标签的 MP3 等）。导入失败后不再直接报错，而是：

| 顺序 | 路径 | 说明 |
|---|---|---|
| 1 | 平台 `decodeAudioData` | 正常路径，最快；成功时零额外开销 |
| 2 | 格式嗅探（魔数） | 判断实际容器/编码，决定下一步与错误措辞 |
| 3 | WAV → 自研 RIFF 解析 | 支持 8/16/24/32bit PCM 与 float32/64，容忍未知块/乱序块 |
| 4 | MPEG → 内置 mpg123（WASM） | 78KB，惰性初始化；正常路径完全不加载 |
| 5 | 其他格式 | 明确提示检测结果 + 转换建议（AMR/SILK/WMA/APE/CAF/AAC-ADTS 等） |

失败信息包含文件大小、检测到的格式与建议，例如：`检测为 MP3（MPEG Layer III，含 ID3 标签）`。

### 打不开 / 导入不了怎么办

1. **页面打不开**：先换网络（Wi-Fi / 移动数据）与浏览器（Chrome / Edge / 夸克新版）；仍不行用第二入口（GitHub Pages 部署后见仓库首页链接）。
2. **点导入没反应 / 选择器里没有文件**：点「选不到文件？用兼容模式选择」——该入口不设 `accept` 过滤，任何支持文件选择的浏览器都会弹出选择器。
3. **白屏或提示「应用没能正常启动」**：页面顶部守卫提示会给出原因；点「① 运行兼容性自检」，把报告复制回传即可定位（报告只含 UA 与能力项，不含隐私数据）。

## 维护者工具

`tools/` 下除构建脚本外，还有三个 GitHub 建库期使用的浏览器自动化工具（依赖 `playwright-core` 与本机 Edge 的已登录会话，cookie 不离开本机）：

```bash
npm i -g playwright-core    # 或设 NODE_PATH 指向其安装目录

# 建库（首次）：网页 UI 创建仓库，含失败诊断与 JS 提交兜底
node tools/github-create-repo.js

# 诊断：dump 指定页面的表单元素与选择器信息
node tools/github-debug-page.js https://github.com/new

# 历史方案（留档，勿用于新操作）：经 Git Data API 直接推送全部文件。
# 实践证明 api.github.com 不接受浏览器会话的跨域 cookie（401），已被上面的
# 「网页 UI 建库 + git push」组合取代；保留它是为了记录完整的踩坑过程。
# node tools/github-push.js
```

仓库建好后，日常更新就是标准 git 流程：改代码 → `node tools/build.js` → `npm test` → `git commit` → `git push`（凭据由系统 Git Credential Manager 管理）。

## 测试

- `node test/core.test.js`：23 项单元测试（重采样/声道归一/拼接/淡变/归一化/WAV 头/边界/目标采样率选择）
- `node test/mp3.test.js`：9 项 MP3 功能测试——用官方 lamejs 真实编码，解析帧头验证同步字、位率索引、采样率索引、帧数、体积，以及进度单调性、取消、异常输入
- `python test/verify_wav.py`：Python 标准库 `wave` 回读生成的 WAV，交叉校验头字段、静音间隔、信号 RMS
- 构建产物校验：3 个 script 块语法、28 个 DOM id 唯一性、CSS 花括号配平、PNG 结构有效性
- 导入性能：Edge 端到端分阶段实测（读取/解码/端到端），V0.2.1 起有预热 + 即时占位反馈

## GitHub 调研结论（2026-10-17 检索）

| 项目 | 用途 | 状态 | 对本项目的意义 |
|---|---|---|---|
| ionic-team/capacitor | Web → iOS/Android 打包 | 活跃，16.8k★，最新 8.5.3 | **本项目的上线路径**，配置已就绪 |
| arthenica/ffmpeg-kit | 移动端 FFmpeg | **已退役**（2025-01 宣布，2025-04 归档、二进制下架；原因：维护精力 + MPEG 专利风险） | 不要作为新项目依赖 |
| arthenica/ffmpeg-kit-next | 官方延续版 | 活跃，仅源码分发 | 需要 FFmpeg 能力时的候选（需自行构建） |
| ffmpegkit-maintained/ffmpeg | 社区维护 Android 分支 | 活跃 | 仅改 groupId 即可从旧 ffmpeg-kit 迁移 |
| ffmpegwasm/ffmpeg.wasm | 浏览器端 FFmpeg | 活跃，17.9k★ | 重型转码备选，~30MB |
| zhuker/lamejs | JS MP3 编码器 | 活跃，899★ | **MP3 输出已接入**（vendor 内联） |
| Canardoux/flutter_sound | Flutter 录音/播放 | 活跃，942★ | 原生 Flutter 路线备选 |
| sandreas/m4b-tool | 桌面端音频合并 | 活跃，1.6k★ | 合并/分章算法参考 |
