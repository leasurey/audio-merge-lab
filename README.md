<div align="center">

# 录音合并器 · Audio Merge Lab

**纯本地 · 无上传 · 打开即用的录音合并工具**

导入或录下多段音频，按顺序合并为一个 WAV / MP3 / M4A —— 全程在你的设备本地完成，数据不经过任何服务器。

[![Version](https://img.shields.io/badge/version-0.4.2-4f8cff)](CHANGELOG.md)
[![License](https://img.shields.io/badge/license-MIT-3fb950)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Web%20·%20iOS%20·%20Android-a371f7)](#-兼容性)
[![Privacy](https://img.shields.io/badge/隐私-纯本地不上传-ff6b6b)](#-已知限制)

**[🌐 在线使用](https://audio-merge-lab.app.workbuddy.host/)** ·
[使用指南](guide.html) ·
[格式转换](convert.html) ·
[兼容性自检](compat.html) ·
[常见问题](#-常见问题)

</div>

---

## ✨ 功能特性

- **多格式导入**：mp3 / m4a / wav / webm / ogg / flac，支持多选；选中即显示「解码中」，逐条反馈
- **内置录音**：自动按平台优选编码（iOS → m4a/aac，Android → webm/opus），录完即可合并
- **片段剪切**：每段可自定义起止范围（滑杆 + 数字输入），合并时零拷贝按区间读取
- **一键复制片段**：同一段音频要重复出现时直接复制，共享数据不额外占内存
- **拖拽排序**：按住左侧把手拖动调整顺序（Pointer Events，鼠标与触摸通用）
- **三种输出**：WAV（无损）/ MP3（96–320 kbps，分块编码 + 进度 + 可取消，**默认**）/ M4A（AAC 实时录制）
- **灵活拼接**：片段间隔 0–3 秒可调、首尾淡变防爆音、可选峰值归一化（统一各段音量）
- **长音频友好**：流式合并 + OPFS 磁盘落盘，两个 40 分钟文件合并内存峰值从 ~4GB 降到 ~200MB
- **解码降级链**：平台解不动的 WAV / MP3 自动换内置解析器（V0.3.5 起真正生效），不支持格式精确报名并给转换建议
- **分享 / 下载**：Web Share API 一键分享；iOS 可用可选的局域网服务生成下载直链，存到「文件」App（见下）
- **PWA**：可添加到主屏、离线可用
- **老浏览器兜底**：ES5 启动守卫 + 兼容性自检页，旧内核看到的是可读提示而不是白屏

## 🚀 快速开始

**在线使用（推荐）**：直接打开 [audio-merge-lab.app.workbuddy.host](https://audio-merge-lab.app.workbuddy.host/)，无需安装。
备用入口：[GitHub Pages](https://leasurey.github.io/audio-merge-lab/)。

**本地运行**：

```bash
git clone https://github.com/leasurey/audio-merge-lab.git
cd audio-merge-lab
node tools/build.js        # dist/ 不入库，克隆后先构建一次
python -m http.server 8000 # 手机连同一 Wi-Fi 访问 http://<电脑IP>:8000/dist/
```

> 直接双击 `dist/index.html` 也能用（导入 / 合并 / MP3 均可）；「录音」需要 localhost 或 HTTPS 环境。

### iOS 想保存成文件？用可选的局域网服务

iOS 上没有稳定的"前端直接保存文件"通道：`a[download]` 各版本行为反复，`window.open(blobURL)`
只会交给系统播放器打开，而**系统播放器没有保存入口**。所以做了一个可选的本地服务，
走「服务端直链 + `Content-Disposition: attachment`」——这是 iOS 上最稳的一条路。

```bash
node tools/build.js
node tools/serve.js            # 默认 8010 端口，占用时：--port 8020
```

控制台会打印局域网地址（如 `http://192.168.0.8:8010`），手机与电脑连**同一个 Wi-Fi**，
用 Safari 打开它 → 正常合并 → 结果区会多出「💾 生成保存链接」：

1. 点「生成保存链接」→ 结果上传到本机服务（进度条可见，文件落在项目 `uploads/`，6 小时后自动清理）
2. 点出现的链接 → Safari 下载 → 存到「文件」App；若点了没反应，**长按链接**选「下载链接文件」

> 手机打不开时多半是 Windows 防火墙拦截：右键 `tools/allow_lan.bat` → **以管理员身份运行**
> （端口不对就带参数：`tools\allow_lan.bat 8020`）。撤销：`netsh advfirewall firewall delete rule name="AML-Serve-8010"`。

> 该服务**完全可选**：不运行时页面与线上版本行为不变（保存入口不显示）。只有你主动点
> 「生成保存链接」时音频才会离开浏览器，且只到你自己电脑的 `uploads/` 目录。
> 建议在可信的家用 / 办公网络下使用，不要直接暴露到公网。

## 📱 三步上手

1. **添加片段** — 「＋ 导入音频文件」多选，或「开始录音」现录一段
2. **调整顺序** — 按住左侧 ⠿ 把手拖动排序；▶ 试听、✂ 剪切、⧉ 复制、✕ 移除
3. **选格式合并** — 默认输出 MP3；进度走完 → 试听 → 「分享 / 下载」

> 每段都可以点 ✂ 设定起止范围，只合并选中的部分（面板实时显示保留时长，所见即所得）。

### 输出格式怎么选

| 格式 | 特点 | 适合 |
|---|---|---|
| **WAV**（推荐） | 无损，约 10 MB/分钟，合并几乎瞬间完成 | 存档、二次剪辑、音质优先 |
| **MP3** | 体积约 WAV 的 1/10；10 分钟音频约需 1–2 分钟编码，可取消 | 发给别人、上传平台 |
| **M4A** | 体积小；实时编码（耗时与音频等长，需保持前台） | 苹果生态 |

## 🧩 兼容性

产物为 **ES2017**（Chromium 55+ / iOS 11+）；启动守卫与自检页为纯 **ES5**。构建期用 acorn 强制校验语法基线。

| 浏览器 | 已知问题 | 本项目应对 |
|---|---|---|
| Chrome / Edge / Firefox / 三星 | 无 | 基准平台 |
| 夸克 | 自有网络栈偶发「网页打不开」 | 备用入口 + 自检页 |
| UC / QQ / 微信内置（X5） | accept 过滤异常；旧设备内核低至 Chromium 53 | 兼容模式导入 + 启动守卫提示 |
| 华为 / 荣耀 / vivo / 小米 / OPPO / 百度 / 360 | accept 过滤偶发异常、下载入口差异 | 兼容模式导入 + Web Share 兜底 |

> 上表基于公开内核信息与社区已知问题整理，未逐台真机验证——[`compat.html`](compat.html) 的意义正是让任何设备一条链接跑出真实能力报告。

### 解码降级链

平台 `decodeAudioData` 失败时（Android 厂商内核、桌面 Chrome 的 AAC 等）自动降级：

```
平台 decodeAudioData → 魔数嗅探 → WAV？自研 RIFF 解析（PCM 8/16/24/32bit + float）
                                  → MPEG？内置 mpg123（WASM，78KB，惰性加载）
                                  → 其他格式？精确报出检测结果 + 转换建议
```

- 平台解码成功时零额外开销；mpg123 仅在失败时加载
- 压缩 WAV（A-law / ADPCM / MPEG 等）明确报错，绝不按 PCM 硬解析产出噪声
- 文件损坏（平台只解出几十毫秒）会转内置解码并在列表显示**黄色警示行**，请试听后决定去留，不会静默丢失
- 失败信息包含文件大小、检测格式与建议，例如：`检测为 MP3（MPEG Layer III，含 ID3 标签）`

## ❓ 常见问题

<details>
<summary><b>iOS 上点「分享 / 下载」不弹分享面板，直接跳到全屏播放器</b></summary>

V0.4.2 之前有一个「体积 > 80MB 就直接交给播放器」的提前返回，而 40 分钟左右的 WAV 约 400MB，
必然命中——于是 `navigator.share` 根本没机会执行。现在已删除该分支，**无论文件多大都先尝试
系统分享**（分享面板 → 「存储到文件」是 iOS 上不依赖电脑的唯一保存通道）。

若分享面板仍然没弹出（例如旧版 Safari 不支持分享文件，或文件大到分享失败），结果区会给出
可点/可长按的保存链接与分步提示。最省事的做法仍是：

1. 改用 **MP3** 输出（体积约为 WAV 的 1/10，分享成功率高得多）
2. 或在电脑上跑 `node tools/serve.js`，手机用 Safari 打开它打印的局域网地址，点「💾 生成保存链接」
</details>

<details>
<summary><b>点导入没反应 / 选择器里没有文件</b></summary>

部分国产内核对 `accept` 过滤有 bug。点「选不到文件？用兼容模式选择（不过滤格式）」，该入口任何浏览器都能弹出选择器。
</details>

<details>
<summary><b>页面打不开</b></summary>

先换网络与浏览器（Chrome / Edge / 夸克新版）；仍不行用备用入口（GitHub Pages），或打开 <a href="compat.html">compat.html</a> 自检并把报告复制回传。
</details>

<details>
<summary><b>白屏 / 提示「应用没能正常启动」</b></summary>

浏览器内核过旧（不支持 async/await，需 Chromium 55+ / iOS 11+）。按页面提示运行兼容性自检定位，报告只含 UA 与能力项，不含隐私数据。
</details>

<details>
<summary><b>导入失败，提示检测为 AMR / SILK / WMA / APE</b></summary>

这些编码浏览器都不支持，需先转换：AMR（通话录音）→ 手机「录音机」转 MP3；SILK（微信语音）→ 导出为 MP3；WMA / APE / CAF → 格式工厂等工具。详见 <a href="convert.html">格式转换</a>。
</details>

<details>
<summary><b>列表出现黄色「请试听确认」警示</b></summary>

该文件可能已损坏（平台只解出几十毫秒，内容由内置解码器还原）。先试听确认完整性，不完整就删除该片段，不要直接合并。
</details>

<details>
<summary><b>合并长音频时页面重载</b></summary>

浏览器内存上限所致。V0.3.0 起输出已走流式（OPFS 落盘优先），但仍建议：不支持 OPFS 的旧浏览器换 Chrome / Edge，或改用 MP3 输出、分段合并。
</details>

## ⚠️ 已知限制（如实说明）

- 导入解码依赖浏览器原生解码器（实测约 1–2ms/秒音频 + 约 0.5s 固定开销），快不过系统解码器
- 长音频合并的内存下限是「已解码输入」本身；不支持 OPFS 的旧浏览器上几十分钟合并仍可能触发上限（页面重载）——浏览器限制，代码只能缓解
- M4A 为实时编码（耗时与音频等长），且依赖浏览器 mp4 录制能力，不支持时选项自动隐藏
- 桌面 Chrome 不支持 AAC 解码（m4a 导入在 iOS / Android 上正常）
- 只做顺序拼接 + 间隔 + 淡变 + 归一化 + 单段剪切（✂ 自定义起止，按源帧区间零拷贝读取，不生成裁剪副本）；变速、交叉淡入淡出不在范围内
- `dist/` 不入库，克隆后需先 `node tools/build.js`
- **iOS 保存**：没有稳定的前端保存通道（系统播放器无保存入口、`a[download]` 行为反复）。
  默认的「分享」可用（含「存储到文件」）；要更稳的直链保存，需自己在本机跑 `tools/serve.js`
  ——这是唯一会让音频离开浏览器的路径（只到你自己的电脑）

## 🏗 项目结构

```text
├─ src/
│   ├─ audio-core.js        核心逻辑（纯函数 UMD）：重采样/拼接/淡变/归一化/WAV/MP3 编码/嗅探/兜底解码
│   │                       ← APP_VERSION 单一权威值在此
│   ├─ app.js               UI 层：导入、录音、试听、流式合并、导出分享
│   ├─ styles.css           深色主题、移动端优先
│   ├─ boot-guard.js        ES5 启动守卫（旧内核白屏兜底）
│   ├─ manifest.webmanifest / sw.js    PWA 清单与离线缓存
│   └─ vendor/              lamejs（MP3 编码）+ mpg123-decoder（MP3 WASM 解码），来源与许可证见 THIRD-PARTY-NOTICES.md
├─ index.template.html      页面骨架（构建占位符）
├─ tools/build.js           构建：内联单文件 + PWA 资源 + 图标生成
├─ tools/serve.js           可选的局域网自托管服务：静态页 + 上传/下载直链（npm run serve）
├─ test/                    51 项核心单测 + 9 项 MP3 功能测试 + 24 项下载服务端到端测试 + Python 交叉校验
├─ compat.html / guide.html / convert.html   自检 / 指南 / 转换页
├─ capacitor.config.json    Capacitor 打包配置（webDir → dist）
└─ CHANGELOG.md · LICENSE · THIRD-PARTY-NOTICES.md · 使用说明.md
```

**合并管线**：

```text
文件/录音 → decodeAudioData（失败则降级链）→ 统一采样率/声道
        → planMerge + createSegmentConverter（无状态分帧，流式直写）
        → encodeWav / encodeMP3(lamejs) / encodeM4A(MediaRecorder)
        → OPFS 磁盘文件或内存 Blob → 试听 / 分享 / 下载
```

为什么先解码再拼接：压缩音频直接拼字节流只在各段编码参数完全一致时才安全，录音文件参数各异，走 PCM 是唯一稳妥路线。

## 🧪 开发

```bash
node tools/build.js                                  # 构建（单文件 HTML + PWA + 图标）
npm test                                             # 51 + 9 + 24 项测试
node tools/serve.js                                  # 可选：启动局域网下载服务（默认 8010）
python test/verify_wav.py                            # Python wave 模块交叉校验 WAV 产物
```

- 核心逻辑（`audio-core.js`）为纯函数，可在 Node 直接单测；UI 层（`app.js`）与核心分离
- 构建期校验：ES2017 / ES5 语法基线（acorn）、产物无 NUL 字节、vendor 文件无 `<script>`
- 测试不止"有输出"：MP3 测试解析真实帧头验证同步字/位率/采样率；WAV 用 Python 标准库交叉校验

### 打包为原生 App（Roadmap）

工程已就绪（Capacitor 8.5.3），在有网机器上：

```bash
npm install && npm run build
npx cap add android && npx cap add ios   # iOS 需 macOS + Xcode
npm run cap:sync && npm run cap:open:android
```

需手动添加原生权限：Android `RECORD_AUDIO`；iOS `NSMicrophoneUsageDescription` + Background Modes（Audio）。设计原则：只用系统公开能力（文件选择器、分享菜单、SAF、前台服务），不做越狱、私有 API、沙箱逃逸。更多维护者资料（生态调研、工具、排障记录）见 [docs/maintainer-notes.md](docs/maintainer-notes.md)。

## 🙏 致谢

| 来源 | 使用内容 |
|---|---|
| [zhuker/lamejs](https://github.com/zhuker/lamejs) | MP3 编码器（LGPL-3.0，vendor 内联，SHA-1 已校验） |
| [eshaz/wasm-audio-decoders](https://github.com/eshaz/wasm-audio-decoders) | mpg123 WASM MP3 解码器（MIT，降级链兜底） |
| [ionic-team/capacitor](https://github.com/ionic-team/capacitor) | Web → iOS/Android 打包方案 |

本项目代码为原创，开发过程使用了 AI 编程助手辅助（AI-assisted development）。

## 📄 许可证

[MIT](LICENSE)。附加说明：MIT 仅覆盖本项目原创代码；`src/vendor/` 内第三方库按其上游许可证处理（lamejs 为 LGPL-3.0），详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

---

<div align="center">

**作者 k** · [B 站主页](https://space.bilibili.com/527557440) · [在线使用](https://audio-merge-lab.app.workbuddy.host/)

如果这个项目对你有帮助，欢迎点个 ⭐

</div>
