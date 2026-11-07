# 录音合并器

在浏览器中把多段录音合并为一个音频文件。无需安装，文件不上传。

[在线使用](https://audio-merge-lab.app.workbuddy.host/) · [使用指南](guide.html) · [格式转换](convert.html) · [兼容性自检](compat.html) · [更新日志](CHANGELOG.md)

## 概览

录音合并器是一个在浏览器中运行的音频合并工具。它读取你设备上的音频文件，或直接录音，按你排定的顺序拼接为一个文件，输出为 WAV、MP3 或 M4A。

解码、合并与编码都在本机浏览器内完成，关闭页面后不留存任何音频。除你在本地自行开启的服务（见「在 iPhone 上存储到文件」）外，应用不会向任何服务器发送数据。

它只做顺序拼接。不支持多轨混音、变速、降噪或音效处理。

## 使用方法

1. 点按「导入音频文件」选取一段或多段音频，或点按「开始录音」录制新片段。
2. 按住片段左侧的 ⠿ 拖移，调整先后顺序。
3. 选取输出格式，点按底部的「合并」。

合并完成后，点按「分享 / 下载」保存或共享文件。在 iPhone 上选取「存储到文件」，可将结果保存到「文件」App。

片段左侧的按钮依次用于试听、裁剪、复制与移除。裁剪可指定起止时间，只合并保留的部分。

## 支持的输入格式

| 格式 | 说明 |
| --- | --- |
| MP3、WAV、M4A、AAC | 常见音频文件 |
| WebM、Ogg、FLAC | 浏览器录音与常见音频格式 |
| MP4、MOV | 手机录屏。应用会提取其中的音频轨道，无需先行转换 |

如果文件容器标注的编码与实际内容不符（例如 WAV 容器内装的是 MP3 数据，或 MP4 的音轨为 MPEG 音频），应用会定位并提取内部音频帧后解码。

## 输出格式

| 格式 | 特点 | 适用场景 |
| --- | --- | --- |
| WAV | 无损，约 10 MB/分钟，合并几乎瞬间完成 | 存档、后续还要剪辑 |
| MP3 | 体积约为 WAV 的 1/10。10 分钟音频约需 1–2 分钟编码，可取消 | 共享、上传 |
| M4A | 体积与 MP3 相当。实时编码，耗时与音频等长，期间需保持页面前台 | 在 Apple 设备之间流转 |

码率不是越低越快。96 kbps 实测比 128 kbps 慢约 2.9 倍，因此该选项标注为「编码较慢」。

## 兼容性

产物按 ES2017 编写，适用于 Chromium 55+ 与 iOS 11+。启动守卫与自检页按纯 ES5 编写，构建时用 acorn 校验语法基线。

| 浏览器 | 已知问题 | 应对方式 |
| --- | --- | --- |
| Chrome、Edge、Firefox、Samsung Internet | 无 | 基准平台 |
| 夸克 | 自有网络栈偶发无法打开页面 | 备用入口与自检页 |
| UC、QQ、微信内置浏览器（X5） | 文件类型过滤异常；旧设备内核低至 Chromium 53 | 兼容模式导入、启动守卫提示 |
| 华为、荣耀、vivo、小米、OPPO、百度、360 | 文件类型过滤偶发异常，下载入口存在差异 | 兼容模式导入、共享面板兜底 |

上表按公开内核信息与社区反馈整理，未逐台设备验证。要确认某台设备的实际能力，用该设备打开[兼容性自检](compat.html)，页面会生成一份报告。

### 解码顺序

平台解码器优先。失败时按格式交由内置解析器处理：

```text
decodeAudioData
  ├─ WAV        → 自研 RIFF 解析（PCM 8/16/24/32 位与浮点）
  ├─ MPEG       → 内置 mpg123（WASM，78 KB，按需加载）
  ├─ MP4 / MOV  → 内置 faad2（WASM，232 KB，按需加载）
  └─ 均不支持   → 报出实际检测到的格式与转换建议
```

MP4 与 MOV 采用内置优先：先提取音频轨道（AAC 交由 faad2，MPEG 音频交由 mpg123），失败后再交回平台解码器。各平台对 AAC 的实现不一致，自行解码的结果更可预期。

压缩 WAV（A-law、ADPCM、MPEG-in-WAV）会直接报错，不按 PCM 解析。硬解的结果是满幅噪声，比报错更糟。

平台只解出几十毫秒时，应用会转由内置解析器处理，并在片段上显示黄色警示，不静默丢弃内容。

## 已知限制

- 解码耗时取决于浏览器解码器，约 1–2 毫秒/秒音频，另有约 0.5 秒固定开销。
- 长音频的内存下限是解码后的输入本身。在不支持 OPFS 的旧浏览器上，几十分钟的合并可能触发页面重新载入。
- M4A 为实时编码，耗时与音频等长。浏览器不支持 MP4 录制时，该选项自动隐藏。
- 部分 Android 内核解码 AAC 时会随机丢弃帧且不报错（实测 54.36 秒只解出 50.15 秒）。检测到时长偏差时会改用内置解码器重新解码。
- 仅支持顺序拼接、间隔、淡入淡出、归一化与单段裁剪。不支持变速与交叉淡化。
- 输出声道数由输入决定，没有强制单声道或强制立体声的开关。
- 自动单声道与后台让出的收益仅在桌面版 Edge 实测过，Android 各机型仍缺数据。
- iOS 没有稳定的前端保存通道：系统播放器没有保存入口，`a[download]` 各版本行为不一致。默认走共享面板；需要更可靠的直链保存时，在本机运行 `tools/serve.js`。

## 本地运行

```bash
git clone https://github.com/leasurey/audio-merge-lab.git
cd audio-merge-lab
node tools/build.js          # dist/ 不入库，克隆后先构建
python -m http.server 8000   # 手机连同一 Wi-Fi，访问 http://<电脑 IP>:8000/dist/
```

也可以直接打开 `dist/index.html`。导入、合并与 MP3 输出均可使用；录音需要 localhost 或 HTTPS 环境。

### 在 iPhone 上存储到文件

iOS 上无法由网页直接把文件写入「文件」App：系统播放器没有保存入口，`window.open(blobURL)` 只会交给播放器打开。可行的做法是由服务端提供直链，并附带 `Content-Disposition: attachment`。

```bash
node tools/build.js
node tools/serve.js            # 默认端口 8010，被占用时使用 --port 8020
```

终端会打印局域网地址，例如 `http://192.168.0.8:8010`。让 iPhone 与电脑连接同一 Wi-Fi，用 Safari 打开该地址。合并后结果区会显示「生成保存链接」。

1. 点按「生成保存链接」，文件上传到本机服务。进度条可见，文件存放在项目的 `uploads/` 目录，6 小时后自动清理。
2. 点按出现的链接下载。若无响应，长按链接并选取「下载链接文件」。

手机无法打开时，多为防火墙拦截。右键点按 `tools/allow_lan.bat`，选取「以管理员身份运行」。端口不同时带上参数：`tools\allow_lan.bat 8020`。

该服务完全可选。不运行时，页面行为与在线版本一致，保存入口不会显示。只有你主动点按「生成保存链接」时，音频才会离开浏览器，且只传到你自己的电脑。请勿将此服务暴露到公网。

## 项目结构

```text
├─ src/
│   ├─ audio-core.js        核心逻辑（纯函数 UMD）：重采样、拼接、淡变、归一化、编码、嗅探、解封装
│   │                       APP_VERSION 唯一权威值在此
│   ├─ app.js               UI 层：导入、录音、试听、流式合并、导出
│   ├─ styles.css           明暗双主题，移动端优先
│   ├─ doc.css              文档页共享样式（使用指南、格式转换、兼容性自检）
│   ├─ boot-guard.js        ES5 启动守卫，旧内核白屏兜底
│   ├─ manifest.webmanifest、sw.js    PWA 清单与离线缓存
│   └─ vendor/              lamejs（MP3 编码）、mpg123 与 faad2（WASM 解码）
├─ index.template.html      页面骨架，构建时替换占位符
├─ tools/build.js           构建：内联单文件、PWA 资源、图标
├─ tools/serve.js           可选的局域网服务：静态页、上传与下载直链
├─ test/                    自动测试（核心、MP3、服务端、主页契约）与 Python 交叉校验
├─ compat.html、guide.html、convert.html   自检、指南、转换页
└─ capacitor.config.json    Capacitor 打包配置（webDir 指向 dist）
```

## 合并管线

```text
文件或录音 → decodeAudioData（失败则走降级链）→ 统一采样率
          → pickTargetChannels（全单声道取 1，否则取 2；整次只计算一次）
          → planMerge + createSegmentConverter（无状态分帧，流式直写）
          → encodeWav / encodeMP3（lamejs）/ encodeM4A（MediaRecorder）
          → OPFS 磁盘文件或内存 Blob → 试听 / 共享 / 下载
```

先解码再拼接，是因为压缩音频直接拼接字节流只在各段编码参数完全一致时才成立。录音文件的参数各不相同，走 PCM 是唯一稳妥的路径。

声道必须在合并前统一。混合输入一律上混为立体声，全部为单声道时才按单声道输出，否则会出现某段只写入一侧声道的错位。

## 开发

```bash
node tools/build.js        # 构建（单文件 HTML、PWA 资源、图标）
npm test                   # 全部测试，含构建与主页契约检查
npm run verify             # 上述全部，另加 Python 双路 WAV 校验
node tools/serve.js        # 可选：局域网下载服务
```

- 核心逻辑为纯函数，可在 Node.js 中直接单测，与 UI 层分离。
- 构建期校验 ES2017 与 ES5 语法基线、产物不含 NUL 字节、第三方文件不含 `<script>`。
- 测试不只看是否有输出：MP3 测试解析真实帧头，核对同步字、码率与声道模式；WAV 用 Python 标准库交叉校验。
- `test/ui.test.js` 锁定主页契约，包括构建占位符、`app.js` 依赖的 DOM id、明暗配色、窄屏布局与许可文本的分发。改动模板破坏契约会立即失败。

### 打包为原生 App

工程已配置 Capacitor 8.5.3。在可联网的机器上执行：

```bash
npm install && npm run build
npx cap add android && npx cap add ios   # iOS 需要 macOS 与 Xcode
npm run cap:sync && npm run cap:open:android
```

需手动添加原生权限：Android 添加 `RECORD_AUDIO`；iOS 添加 `NSMicrophoneUsageDescription` 与 Background Modes（Audio）。

设计上只使用系统公开能力，包括文件选择器、共享菜单、SAF 与前台服务，不使用越狱、私有 API 或沙箱逃逸。维护者资料见 [docs/maintainer-notes.md](docs/maintainer-notes.md)。

## 第三方组件

| 来源 | 内容 | 许可证 |
| --- | --- | --- |
| [zhuker/lamejs](https://github.com/zhuker/lamejs) | MP3 编码器。内联于 vendor，SHA-1 已校验 | LGPL-3.0 |
| [eshaz/wasm-audio-decoders](https://github.com/eshaz/wasm-audio-decoders) | mpg123（MP3 解码）、faad2（AAC 解码） | MIT / GPL-2.0（faad2 内核） |
| [ionic-team/capacitor](https://github.com/ionic-team/capacitor) | Web 到 iOS、Android 的打包方案 | MIT |

`src/vendor/` 中的第三方库遵循各自的上游许可证，详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。faad2 为 GPL-2.0，闭源分发前请先阅读该说明。

开发过程使用了 AI 编程助手辅助。

## 许可证

[MIT](LICENSE)。MIT 许可仅覆盖本项目的原创代码。`src/vendor/` 中的第三方库按上游许可证处理。

---

作者 k · [B 站主页](https://space.bilibili.com/527557440) · [在线使用](https://audio-merge-lab.app.workbuddy.host/)
