# 录音合并器

把几段录音拼成一个文件。在浏览器里跑，不用安装。

支持导入或现录，输出 WAV / MP3 / M4A。文件在页面内解码和合并，不上传。

**[在线使用](https://audio-merge-lab.app.workbuddy.host/)** · [使用指南](guide.html) · [格式转换](convert.html) · [兼容性自检](compat.html) · [更新日志](CHANGELOG.md)

---

## 关于这个项目

起因很简单：手机上录了一堆分段音频，找不到一个能直接按顺序拼起来的工具。有的要装 App，有的要上传到服务器，有的导出一半就崩。

所以写了这个：一个 HTML 文件，双击能开，扔到任意静态托管也能用。工作在你自己的浏览器里，关掉页面就什么也不留。

它只做一件事——**顺序拼接**。不做多轨、不做变速、不做降噪、不做特效。需要这些请用 Audacity 或别的软件。

维护者是个人，不是团队。功能按实际遇到的需求加，不稳定的一律不加。项目用 MIT 许可，代码可自由取用。

## 能做什么

- **导入**：mp3 / m4a / wav / webm / ogg / flac / mp4 / mov，可多选，逐个反馈解码状态
  - 手机录屏的 mp4、mov 会直接取内部音轨——不需要先转成 mp3
  - 容器标错的文件（WAV 里装 MP3、MP4 里装 MPEG、改过扩展名）会提取内部音频帧再解
- **录音**：iOS 录 m4a，安卓录 webm/opus，录完直接进列表
- **排序**：按住 ⠿ 拖动；每段可试听、剪切（自定义起止）、复制、移除
- **输出**：WAV（无损）/ MP3（96–320 kbps，默认）/ M4A（边编边写）
- **拼接选项**：片段间隔 0–3 秒、首尾淡变防爆音、峰值归一化统一音量
- **单声道自动判断**：全部片段都是单声道时按单声道编码，MP3 编码量减半；混进立体声就整次输出立体声
- **长音频**：流式合并 + OPFS 落盘，两个 40 分钟文件合并内存峰值在 1 GB 以内
- **离线**：加到主屏后可断网使用

## 使用

1. 点「＋ 导入音频文件」多选，或「开始录音」现录一段
2. 按住左侧 ⠿ 拖动排序；需要的话点 ✂ 设定保留区间
3. 选输出格式，点底部「合并」

iOS 上「分享 / 下载」会调起系统分享面板，选「存储到文件」即可保存。

## 输出格式怎么选

| 格式 | 特点 | 适合 |
|---|---|---|
| WAV | 无损，约 10 MB/分钟，合并几乎瞬间完成 | 存档、还要再剪辑 |
| MP3 | 体积约 WAV 的 1/10；10 分钟音频约需 1–2 分钟编码，可取消 | 发给别人、上传平台 |
| M4A | 体积与 MP3 相当；实时编码，耗时与音频等长，需保持页面在前台 | 苹果设备间流转 |

位率不是越低越快：96 kbps 实测比 128 kbps 慢约 2.9 倍，所以选项里标了「编码较慢」。

## 兼容性

产物为 ES2017（Chromium 55+ / iOS 11+），启动守卫与自检页为纯 ES5，构建时用 acorn 校验语法基线。

| 浏览器 | 已知问题 | 应对 |
|---|---|---|
| Chrome / Edge / Firefox / 三星 | 无 | 基准平台 |
| 夸克 | 自有网络栈偶发打不开 | 备用入口 + 自检页 |
| UC / QQ / 微信内置（X5） | accept 过滤异常；旧设备内核低至 Chromium 53 | 兼容模式导入 + 启动守卫提示 |
| 华为 / 荣耀 / vivo / 小米 / OPPO / 百度 / 360 | accept 过滤偶发异常、下载入口差异 | 兼容模式导入 + Web Share 兜底 |

上表按公开内核信息和社区反馈整理，没有逐台真机验证。想知道某台设备到底支持什么，用它打开 [`compat.html`](compat.html)，会跑出一份真实能力报告。

### 解码顺序

平台解码器优先，失败则按格式走自己的解析器：

```
decodeAudioData
  ├─ WAV          → 自研 RIFF 解析（PCM 8/16/24/32bit + float）
  ├─ MPEG         → 内置 mpg123（WASM，78 KB，惰性加载）
  ├─ MP4 / MOV    → 内置 faad2（WASM，232 KB，惰性加载）
  └─ 都解不了     → 报出实际检测到的格式与转换建议
```

MP4 / MOV 走的是内置优先：先取音频轨（AAC → faad2；MPEG → 切片 + mpg123），失败才交回平台解码器。原因是各家平台的 AAC 解码行为不一致，自己解结果更可预测。

- 压缩 WAV（A-law / ADPCM / MPEG-in-WAV）明确报错，不按 PCM 硬解——那样出来的是满幅噪声，比报错更糟
- 平台只解出几十毫秒时会转内置解码，并在列表挂黄色警示，不静默丢内容
- 失败提示会写明卡在哪一步

## 已知限制

- 解码要等，速度取决于浏览器解码器：约 1–2 ms/秒音频，另有约 0.5 秒固定开销
- 长音频的内存下限是「已解码的输入」本身。不支持 OPFS 的旧浏览器上，几十分钟的合并不一定扛得住，可能触发页面重载
- M4A 是实时编码，耗时与音频等长；浏览器不支持 mp4 录制时该选项自动隐藏
- 部分安卓内核解 AAC 会随机丢帧且不报错（实测 54.36 s 只解出 50.15 s）。检测到时长偏差会改用内置解码器重解
- 只做顺序拼接、间隔、淡变、归一化、单段剪切。变速、交叉淡入淡出不在范围内
- 输出声道数由输入决定，没有「强制单声道/立体声」开关
- 自动单声道、后台让出的收益只在桌面 Edge 实测过，安卓各机型还需真机数据
- iOS 没有稳定的前端保存通道：系统播放器没有保存入口，`a[download]` 各版本行为不一。默认走系统分享面板；要更稳的直链保存需在本机跑 `tools/serve.js`（见下）

## 本地运行

```bash
git clone https://github.com/leasurey/audio-merge-lab.git
cd audio-merge-lab
node tools/build.js          # dist/ 不入库，克隆后先构建
python -m http.server 8000   # 手机连同一 Wi-Fi，访问 http://<电脑IP>:8000/dist/
```

双击 `dist/index.html` 也能用（导入、合并、MP3 都行），但录音需要 localhost 或 HTTPS。

### iOS 想存成文件？跑一个可选的本地服务

iOS 上「前端直接把文件存到文件 App」这条路走不通：系统播放器没有保存入口，`window.open(blobURL)` 只会交给播放器打开。可靠的方案是服务端直链 + `Content-Disposition: attachment`。

```bash
node tools/build.js
node tools/serve.js            # 默认 8010，占用时 --port 8020
```

控制台会打印局域网地址（如 `http://192.168.0.8:8010`）。手机与电脑连同一 Wi-Fi，用 Safari 打开它，合并后结果区会多出「生成保存链接」：

1. 点「生成保存链接」，文件上传到本机服务（进度可见，落在项目 `uploads/`，6 小时后自动清理）
2. 点出现的链接下载；若点了没反应，长按链接选「下载链接文件」

手机打不开时多半是防火墙：右键 `tools/allow_lan.bat` → 以管理员身份运行（端口不同就带参数 `tools\allow_lan.bat 8020`）。

这个服务完全可选，不跑它页面行为不变。只有你主动点「生成保存链接」时音频才离开浏览器，且只到你自己的电脑。别把它暴露到公网。

## 项目结构

```text
├─ src/
│   ├─ audio-core.js        核心逻辑（纯函数 UMD）：重采样/拼接/淡变/归一化/编码/嗅探/解封装
│   │                       ← APP_VERSION 唯一权威值在此
│   ├─ app.js               UI 层：导入、录音、试听、流式合并、导出
│   ├─ styles.css           明暗双主题，移动端优先
│   ├─ boot-guard.js        ES5 启动守卫（旧内核白屏兜底）
│   ├─ manifest.webmanifest / sw.js    PWA 清单与离线缓存
│   └─ vendor/              lamejs（MP3 编码）+ mpg123、faad2（WASM 解码）
├─ index.template.html      页面骨架（构建时替换占位符）
├─ tools/build.js           构建：内联单文件 + PWA 资源 + 图标
├─ tools/serve.js           可选的局域网服务：静态页 + 上传/下载直链
├─ test/                    自动测试（核心 / MP3 / 服务端 / 主页契约）+ Python 交叉校验
├─ compat.html / guide.html / convert.html   自检 / 指南 / 转换页
└─ capacitor.config.json    Capacitor 打包配置（webDir → dist）
```

合并管线：

```text
文件/录音 → decodeAudioData（失败则降级链）→ 统一采样率
        → pickTargetChannels（全单声道→1，否则→2；整次只算一次）
        → planMerge + createSegmentConverter（无状态分帧，流式直写）
        → encodeWav / encodeMP3(lamejs) / encodeM4A(MediaRecorder)
        → OPFS 磁盘文件或内存 Blob → 试听 / 分享 / 下载
```

为什么先解码再拼：压缩音频直接拼字节流，只有各段编码参数完全一致才安全。录音文件参数各异，走 PCM 是唯一稳妥路线。

声道必须在合并前统一：混合输入一律上混立体声，全部单声道才按单声道输出——否则会出现某段只写一边声道的错位。

## 开发

```bash
node tools/build.js        # 构建（单文件 HTML + PWA + 图标）
npm test                   # 全部测试（含构建与主页契约检查）
npm run verify             # 上面全部 + Python 双路 WAV 校验
node tools/serve.js        # 可选：局域网下载服务
```

- 核心逻辑是纯函数，可在 Node 直接单测，和 UI 层分开
- 构建期校验：ES2017 / ES5 语法基线、产物无 NUL 字节、vendor 文件无 `<script>`
- 测试不只看「有输出」：MP3 测试解析真实帧头验证同步字、位率、声道模式；WAV 用 Python 标准库交叉校验
- `test/ui.test.js` 锁住主页契约：构建占位符、`app.js` 依赖的 DOM id、明暗配色、窄屏布局、许可文本随产物分发。改模板破坏契约会立刻失败

### 打包成原生 App

工程已配好 Capacitor（8.5.3），在有网机器上：

```bash
npm install && npm run build
npx cap add android && npx cap add ios   # iOS 需 macOS + Xcode
npm run cap:sync && npm run cap:open:android
```

需手动加原生权限：Android `RECORD_AUDIO`；iOS `NSMicrophoneUsageDescription` + Background Modes (Audio)。

设计上只用系统公开能力（文件选择器、分享菜单、SAF、前台服务），不做越狱、私有 API、沙箱逃逸。维护者资料见 [docs/maintainer-notes.md](docs/maintainer-notes.md)。

## 第三方组件

| 来源 | 内容 | 许可 |
|---|---|---|
| [zhuker/lamejs](https://github.com/zhuker/lamejs) | MP3 编码器（vendor 内联，SHA-1 已校验） | LGPL-3.0 |
| [eshaz/wasm-audio-decoders](https://github.com/eshaz/wasm-audio-decoders) | mpg123（MP3 解码）、faad2（AAC 解码） | MIT / GPL-2.0（faad2 内核） |
| [ionic-team/capacitor](https://github.com/ionic-team/capacitor) | Web → iOS/Android 打包 | MIT |

`src/vendor/` 内第三方库按各自上游许可处理，详见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。faad2 为 GPL-2.0，闭源分发前请先看那份说明。

开发过程使用了 AI 编程助手辅助。

## 许可证

[MIT](LICENSE)。MIT 仅覆盖本项目原创代码；`src/vendor/` 内第三方库按其上游许可证处理。

---

作者 k · [B 站主页](https://space.bilibili.com/527557440) · [在线使用](https://audio-merge-lab.app.workbuddy.host/)
