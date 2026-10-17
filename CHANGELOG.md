# 更新日志

本文件记录 **录音合并器（Audio Merge Lab）** 每个版本的变更。版本唯一权威值见 `src/audio-core.js` 的 `APP_VERSION`（`package.json` 的 `version` 与之保持一致）。

---

## V0.3.5 — 2026-10-18

全面缺陷审查后的修复版本：**修复 V0.3.2 解码降级链在生产环境整体失效的严重缺陷**，外加一批健壮性修复（0 帧误判、WAV 压缩格式静默产出噪声、资源泄漏、内存多余拷贝、后台停摆、并发操作竞态）。

### 🐛 严重缺陷修复

- **解码降级链整体失效（P0）**：`decodeAudioData` 会接管（detach）传入的 ArrayBuffer，**失败时也 detach**
  （Chrome/WebKit 实测：成功/失败两种路径事后 byteLength 均为 0）。旧实现解码前建立的字节视图因此变成 0 字节，
  导致嗅探恒返回"空文件（0 字节）"、mpg123 一次都不会被调用——**V0.3.2–V0.3.4 的降级链实际从未生效**，
  所有平台解码失败都被误报为"空文件（0 字节），可能是云盘文件未下载完成"。
  修复：解码前用 `slice` 复制独立头部（≤64KB）用于嗅探；确认有内置解析器时才按需重读全文。
  此前 e2e 用"人为令 decodeAudioData 抛错"（猴补丁）验证，补丁版不 detach，掩盖了该缺陷——
  **方法论教训：验证失败路径必须触发真实的平台失败，替换实现的副作用集合与原实现不等价。**
- **SILK 永远识别不出**：真实微信语音 magic 是 `\x02#!SILK_V3`（SILK 在偏移 3），
  旧嗅探只查偏移 0/1 → 一律漏判为"未知格式"（被 detach 缺陷掩盖，从未暴露）。改为在头部 16 字节内搜索。
- **AAC-ADTS 变体漏判**：`FF F0` / `FF F8` 落到"未知格式"拿不到转换建议。同步字判定改为
  `0xFF + (b1 & 0xF6) === 0xF0`，覆盖全部层位为 00 的变体，且不误伤 MPEG 帧（FA/FB 等）。
- **损坏文件被"成功"解成几十毫秒噪声**：对魔数合法但内容损坏的文件，平台解码器不报错、
  只解出约 26 毫秒（实测 1253 帧）。旧版按成功处理，显示"已解码 0:00"，合并时被静默跳过
  （那一段无声无息消失），全坏时抛内部错误 `planMerge: 所有片段均为空`。
  修复：低于 0.05 秒（`MIN_VALID_SEC`）的结果视为无效，转内置解码器重试；若内置解码器解出内容，
  列表显示黄色警示行"⚠ 平台解码结果异常短…请试听确认后再合并"，不再静默吞掉。
- **`decodeWav` 不校验编码格式**：A-law(6)、μ-law(7)、ADPCM(2/17)、GSM(0x31)、MPEG-in-WAV(0x55) 等
  压缩格式会被按 PCM 逐字节解析，产出**满幅噪声**（实测峰值 1.000）而非报错。
  修复：白名单只接受 PCM(1) / IEEE float(3)，其余显式报错并给出可读格式名；
  WAVE_FORMAT_EXTENSIBLE 仍先解析子格式再判定。

### 🧰 健壮性修复

- **OPFS 写句柄泄漏**：`openMergeSink` 之后的两条提前返回分支（iOS 内存劝阻、>1.2GB 内存估算劝阻）
  未调用 `sink.abort()`，留下未关闭的写句柄与孤儿文件。现在取消时都会关闭。
- **分享路径多余整包拷贝**：`shareOrDownload` 原来走 `fetch(blobURL) → resp.blob()`，把整个结果在内存里
  再物化一份；改为直接用已有 Blob/File 构造分享文件（OPFS 磁盘文件补上缺失的 MIME type）。
- **后台标签页合并停摆**：`nextFrame()` 只用 `requestAnimationFrame`，切后台/锁屏后 rAF 停摆，
  合并卡住直到回前台。现在隐藏时改走 `setTimeout`（后台被节流但仍在推进）。
- **合并中列表操作竞态**：合并进行中删除/移动/清空片段只改了界面，`streamMerge` 持有的仍是开始时
  捕获的数组（结果仍包含被删片段）。现在合并中这三类操作会被明确拒绝并提示先取消合并。

### 📄 其他

- README 版本号从滞留的 V0.3.3 更正为当前版本；SW 注释里的示例缓存名同步
- 新增 `.seg-warn` 警示样式

### 🧪 测试

- 核心测试 41 → **43 项**：压缩 WAV 格式必须报错且带格式名、PCM/float/EXTENSIBLE-PCM 仍可解析、
  SILK 两种 magic 变体、ADTS 全变体 + MPEG 帧不误判
- **新增真实失败验证**：不再用猴补丁模拟解码失败，改用（a）真实浏览器对 AMR/SILK 的原生拒绝、
  （b）"原生实现消费真实 buffer 后判失败"的包装（保留真实 detach 副作用）验证 mpg123 兜底
  成功解码真实 MP3 并能继续合并导出

---

## V0.3.4 — 2026-10-18

修复 iOS Chrome 合并 WAV 成功后页面自动重载、分享按钮不出现的问题。

### 🐛 修复

- **结果加载改为按需（核心修复）**：此前合并成功瞬间会同时做三件重活——
  生成整段 WAV 的 Blob、创建 object URL、并让 `<audio>` 立即加载该大 Blob。
  iOS 的 WKWebView 内存上限很低，峰值触发上限后系统直接杀掉页面进程并自动重载，
  表现就是"界面刷新了一下、分享按钮没出现"。现在：
  - 合并成功**不创建 object URL、不加载媒体**，只展示元信息与「▶ 试听结果」「分享 / 下载」两个按钮
  - object URL 在用户点击试听或分享时才惰性创建；`<audio preload="none">` 默认隐藏
- **iOS 大文件分享降级**：iOS 上对 >80MB 的结果不再走"整包读入内存再分享"，
  直接交给系统播放器打开（流式），由用户在播放器里分享/存储
- **回落路径堆占用降低**：无 OPFS 时，内存块每 32 块折叠为一个子 Blob，
  让浏览器把数据挪出 JS 堆（此前长 WAV 的全部字节一直压在 JS 堆上）
- **iOS 内存保护**：WAV 格式提示追加风险说明；预计输出 >200MB 时合并前弹窗劝阻
  （建议改 MP3 或分段），因为重载发生在成功瞬间、事后无法挽回

> 说明：iOS 内存上限由系统决定，无法在代码里消除；本轮把"成功瞬间"的内存峰值
> 降到接近零，并给出提前劝阻。其余系统（Android / 桌面）内存充裕，同样受益于
> 按需加载（合并成功后不再立即缓冲整个结果）。

---

## V0.3.3 — 2026-10-17

使用指南与格式转换自助入口（用户要求：Web 与 README 同步使用指南，并加格式转换入口，优先国内可用方案）。

### ✨ 新增

- **`guide.html`（网页版使用指南）**：三步上手、输出格式选择对比、长音频说明、常见问题（导入无反应 / 解码失败 / 打不开 / iPhone 录音 / 隐私）
- **`convert.html`（格式转换自助入口）**：
  - 症状对照表（AMR / SILK / WMA / APE / M4A / 异常 MP3 分别怎么处理）
  - 三条路径按隐私与可靠性排序：本地软件（格式工厂 / Audacity）> FFmpeg 命令行（含可一键复制的命令与 `winget install ffmpeg`）> 在线转换（AConvert 中文站 / Convertio 中文版，附"需上传、隐私风险、可达性未经验证"提示）
  - 微信语音（SILK）专项：指向开源 `silk-v3-decoder`
- **应用内入口**：头部新增「第一次用？看使用指南 →」；页脚新增「使用指南 · 格式转换 · 兼容性自检」
- **README 使用指南章节**：三步流程、格式选择表、导入失败处置表（与网页版一致）
- 解码失败提示补一句「转换方法见页脚『格式转换』」；自检页文件诊断失败时给出转换入口链接

### 🔧 变更

- SW 缓存清单加入 `guide.html`、`convert.html`（离线可用）

---

## V0.3.2 — 2026-10-17

导入解码兼容性（用户反馈：Android Edge 上导入 MP3 报 `Unable to decode audio data`）。

### 🔍 排查结论

- 出错文件为普通 MPEG-1 Layer III（48kHz / 64kbps CBR，帧扫描全程无坏帧），
  桌面 Edge 可正常解码 → **问题在平台解码器/解复用层，不在文件本身**
- 原实现只有一条解码路径（`decodeAudioData`），失败即报错，且错误信息不包含
  文件实际格式——无法区分"格式不支持"与"文件损坏/不完整"

### ✨ 新增

- **解码降级链**：`decodeAudioData` 失败后按魔数嗅探实际格式，自动改用内置解析器
  - **WAV** → 自研 RIFF 解析器（`AudioCore.decodeWav`）：支持 PCM 8/16/24/32bit
    与 IEEE float 32/64bit，容忍未知块、乱序块、奇数长度块
  - **MP3/MPEG** → 内置 `mpg123-decoder`（WASM，MIT，78KB，惰性初始化，正常路径零成本）
  - 其余格式 → 明确报出检测结果与可操作建议（AMR / SILK / WMA / APE / CAF 等）
- **`AudioCore.sniffFormat`**：魔数识别 WAV / MP3(ID3、帧同步) / M4A(ftyp) / OGG /
  FLAC / AMR / AAC-ADTS / WebM / WMA / APE / AIFF / CAF / SILK / 空文件
- **精确失败信息**：包含文件名、文件大小、检测到的格式与针对性建议；
  成功降级时状态栏与列表标注「内置解码」

### ⚠️ 实现注意（踩坑记录）

- mpg123-decoder 的 wasm 载荷用 `String.raw` 内嵌，其中含**裸 NUL(U+0000) 字节**。
  HTML 解析器规范会把脚本数据中的 U+0000 替换为 U+FFFD，直接内联会导致
  运行时 `Decode failed crc32 validation`（WASM 载荷损坏）。
  因此该库以 **base64 包装内联**，运行时惰性 `atob + TextDecoder + eval` 还原；
  构建脚本增加终局校验：产物含 NUL 即报错

### 🧪 测试

- 新增 7 项核心测试：嗅探 12 类样本、label 非空约束、WAV 8/16/24bit 与 float32
  round-trip、LIST 块与乱序块容忍、非法输入抛错
- 全部 **41 项核心 + 9 项 MP3** 测试通过
- Edge e2e：人为令 `decodeAudioData` 抛错，验证降级链用 mpg123 成功解码真实
  5:34 MP3（334.1s / 48kHz / 零错误）并正确标注「内置解码」

---

## V0.3.1 — 2026-10-17

Android 生态兼容性工程（用户反馈：他人用夸克浏览器打开显示「网页打不开」；部分浏览器导入失效）。

### ✨ 新增

- **兼容性自检页 `compat.html`**：纯 ES5 编写（旧内核也能执行），自动识别夸克 / UC / QQ(X5) / 百度 / 360 / 华为 / 荣耀 / vivo / 小米 / OPPO / 三星 / Edge / Firefox / 微信内置等，逐项检测 Promise、async/await、for-await、Web Audio、decodeAudioData、MediaRecorder、M4A 录制、getUserMedia、Blob、FileReader、文件选择器、OPFS、Service Worker，给出「完整支持 / 部分受限 / 不兼容」判定，并可一键复制诊断报告（含 UA）回传
- **启动守卫（ES5）**：新增 `src/boot-guard.js`，在旧内核解析 app.js 失败、运行时异常、初始化超时三种情况下显示可读提示（含自检入口与重试），不再白屏
- **导入兼容模式**：新增无 `accept` 过滤的备用文件入口（X5 / 夸克 / UC 等对 accept 过滤有已知 bug，会出现"没有音频文件"或不弹窗）
- 页脚新增「兼容性自检」入口；SW 缓存清单加入 compat.html

### 🔧 变更

- 语法基线从 ES2018 降到 **ES2017**：`cleanOldOpfsFiles` 移除 `for await`（改手动迭代）
- 应用初始化包 try/catch，异常时通过启动守卫显示原因

### 🧪 验证

- 构建期强校验：boot-guard.js 出现箭头函数/let/const/模板字符串即构建失败
- acorn 以 ecmaVersion 2017 解析产物、以 5 解析守卫与自检页（见 README「兼容性」一节）

---

## V0.3.0 — 2026-10-17

修复长音频合并的内存爆炸与 iOS 页面重载（用户实测：两个 40 分钟 MP3 合并吃掉 4GB 内存；超过 50 分钟 iOS Chrome/Safari 直接强制重载页面）。

### 🐛 修复

- **合并管线改为流式（内存峰值数量级下降）**：
  - `AudioCore.createSegmentConverter`：无状态分帧转换器，按绝对输出帧号计算源位置——分块调用与一次性转换结果一致（块边界无接缝，有单元测试逐点验证）
  - `AudioCore.planMerge`：合并前算总帧数（WAV 头部先行写出，无需整体缓冲）
  - `concatSegments` 重写为**单遍直写**：去掉旧实现"每段先建全量 conform 拷贝"的中间层——两个 40 分钟立体声文件峰值从约 4.6GB 降至约 2.8GB（实测口径见下）
  - WAV/MP3 合并改为逐段分块转换 + 逐段释放输入 PCM（保留 blob，重试时自动重新解码），输入不再全程驻留
- **输出落盘（OPFS）**：优先 `createSyncAccessHandle`，回落 `createWritable`，再回落内存块拼接。支持时合并结果直接写 Origin Private File System，**不占浏览器内存**；结果 File 磁盘支撑，试听/分享照常
- **M4A 输出重构**：不再生成合并后的整体 PCM（旧实现 `createBuffer` + `copyToChannel` 又整体拷贝一遍），改为把各段 AudioBuffer 顺序调度进 `MediaRecorder`（GainNode 自动化实现淡变/归一化）——长音频内存约为原来的 1/3
- **内存护栏**：估算合并内存，无 OPFS 且估算超 1.2GB 时弹窗明确警告（建议分段/换格式/换浏览器），不再无声崩溃；有 OPFS 但输入超 2GB 时状态栏提示

### 🧪 测试

- 新增 11 项核心测试：`buildWavHeader` 与 `encodeWav` 头部逐字节一致、`conformedFrameCount` 与 conform 路径长度一致、分块转换（997 帧非对齐边界）与一次性 `concatSegments` 一致、int16 模式与 `floatToInt16` 参考 ±1 LSB、重采样与 `resampleChannel` 一致、空片段安全、`segmentPeakAfterFade` 与转换器输出峰值一致、`planMerge` 总帧数与间隔正确
- 全部 **34 项核心 + 9 项 MP3** 测试通过

---

## V0.2.4 — 2026-10-17

署名与链接（用户要求）。

### ✨ 变更

- 界面页脚新增作者署名与主页链接：**作者 k · [B 站主页](https://space.bilibili.com/527557440)**（新窗口打开）
- `package.json` 新增 `author` 字段；README / 使用说明同步署名
- 版本号结构微调：页脚版本改由 `#appVersion` span 承载（仍取 `AudioCore.APP_VERSION` 单一权威值），作者行为模板静态声明

---

## V0.2.3 — 2026-10-17

兼容性加固（用户反馈 iOS Chrome 问题后继续排查的衍生修复）。

### 🐛 修复

- **PWA 更新失效缺陷**：Service Worker 缓存名原是写死的 `audio-merge-lab-v1`，配合缓存优先策略，发新版后旧缓存永不被清——PWA 用户会一直拿到旧构建（表现为"修复了却没生效"）。现在构建时把 `__CACHE_VERSION__` 替换为 `audio-merge-lab-v<APP_VERSION>`，缓存名随版本变化，activate 自动清旧缓存；导航请求改为**网络优先**（在线必拿最新，断网才回落缓存），双保险
- **iOS 下拉框聚焦缩放**：触屏设备（`pointer: coarse`）上 `<select>` 字号提到 16px，避免 iOS 聚焦时自动放大页面
- **`<label>` 按钮渲染对齐**：`.btn` 显式声明 `display: inline-flex`，确保导入按钮改成 label 后在非 flex 容器里也与 button 渲染一致

### 💡 体验

- 解码失败提示针对已知平台缺口给可操作建议：桌面 Chrome 导入 m4a/aac 会明确告知"桌面版 Chrome 不解码 AAC，请用手机/Safari 或先转 MP3/WAV"（不再只给通用报错）
- 微信内置浏览器（UA 含 MicroMessenger）中录音不支持/权限被拒时，提示点右上角 ⋯ 用默认浏览器打开

---

## V0.2.2 — 2026-10-17

修复 iOS Chrome 导入无反应的兼容性缺陷（用户实测反馈：iOS 16 + App Store 最新版 Chrome 点「导入」无任何反应，Safari 正常）。

### 🐛 修复

- **导入按钮改用 `<label for="fileInput">` 原生激活**：原实现是按钮 JS 调 `fileInput.click()` + input 带 `hidden`（display:none）。iOS 上所有第三方浏览器被苹果强制使用 WKWebView 渲染，而 WKWebView 会静默忽略对 `display:none` 的 file input 的程序化点击（点击事件到不了 input），移动 Safari 却容忍该写法——这精确解释了「Safari 秒导入、Chrome iOS 点死」的现象
- **file input 从 `hidden` 改为视觉隐藏**（`.file-input-hidden`：1px + clip，保留布局盒子）：WKWebView 要求 input 不能被 `display:none` / `visibility:hidden` 隐藏
- app.js 中移除 `fileInput.click()` 程序化调用（label 关联后浏览器原生激活，无需 JS；预热逻辑保留在 label 的 click 处理里）

---

## V0.2.1 — 2026-10-17

导入性能优化（用户实测反馈驱动：长文件导入慢、直接录音却正常）。用真实文件在 Edge 里分阶段计时定位：解码 `decodeAudioData` 占约 1.5 秒且与时长基本无关，属浏览器原生解码器的固定开销；录音之所以不慢是因为它走的是同一条解码路径但文件短、且解码发生在录音结束的等待里。

### ⚡ 性能

- **即时占位反馈**：选中文件立刻在列表出现「解码中」片段（文件名立即可见），按队列顺序解码并逐条汇报，不再干等一个状态行
- **音频管线预热**：点「导入」（文件选择器打开前）/「开始录音」（权限弹窗前）即创建 AudioContext 并解码一个 0.1 秒微型 MPEG-1 Layer III（FF FB 头，与真实文件同解码路径）——移动端选择器/权限框要数秒，预热完全藏在这段等待里。实测首个文件解码约 1.6s → 0.9s（桌面 Edge）
- **零拷贝声道存储**：直接持有 AudioBuffer 声道视图而非全量拷贝（合并管线从不原地修改输入，`conformPcm` 先 slice 再处理，视图安全）。11 分钟立体声省约 120 MB 内存峰值
- **自适应目标采样率**（`AudioCore.pickTargetRate`）：输入均为 48kHz 时合并目标直接沿用，免去 48→44.1 重采样（更快，且避免线性插值的音质损失）；混合/非标准采样率仍统一到 44.1kHz

### 🧪 测试

- 新增 `pickTargetRate` 4 组 7 项断言（同采样率沿用 / 混合回落 / 非标准率重采样 / 空输入）
- 全部 32 项测试通过（23 核心 + 9 MP3 功能）
- 浏览器端到端实测：Edge + 用户提供的真实文件（5:34 / 11:08），分阶段计时（读取/解码/拷贝/端到端），优化前后对比

---

## V0.2.0 — 2026-10-17

首个公开版本。从原型一次成型为可用的跨平台工具。

### ✨ 功能

- **导入**：mp3 / m4a / wav / webm / ogg / flac，支持多选，浏览器内解码（`decodeAudioData` → PCM）
- **录音**：`MediaRecorder` 按平台自动优选容器（iOS → mp4/aac，Android → webm/opus）
- **片段管理**：试听（▶/⏸，播放行高亮）、上移/下移、移除、清空；object URL 按需创建、及时释放
- **三种输出格式**：
  - WAV：16bit / 44.1kHz / 立体声，无损
  - MP3：lamejs 本地编码，96–320 kbps 可选，**分块异步 + 进度条 + 可取消**
  - M4A(AAC)：`MediaRecorder` 实时捕获（仅支持 mp4 录制的浏览器显示该选项，耗时与音频等长）
- **合并选项**：片段间隔 0–3 秒、峰值归一化（默认 8 倍增益上限，防噪声放大）、首尾 8ms 淡变防爆音
- **底部常驻操作栏**：实时显示段数 / 合计时长 / 预计体积
- **导出**：系统分享（Web Share API）优先，iOS 降级为新窗口打开，其余降级为下载
- **PWA**：manifest + service worker + 程序化生成图标；可添加到主屏、离线可用

### 🧪 测试与校验

- 28 项自动化测试全部通过：19 项核心单元（重采样/声道归一/拼接/淡变/归一化/WAV 编码/边界）+ 9 项 MP3 功能（官方 lamejs 真实编码，解析帧头验证同步字、位率索引、采样率索引、帧数、体积，以及进度单调性、取消、异常输入）
- Python `wave` 模块交叉校验生成的 WAV（头字段、静音间隔、信号 RMS）
- lamejs 官方文件 git blob SHA-1 校验通过（`8dc6b072…`，与上游仓库一致）

### 🐛 修复（开发过程中实测发现）

1. 测试中发现 `Float32Array.fill(0.9)` 与字面量 `0.9` 不严格相等（Float32 精度）——断言改用误差范围
2. 归一化默认 8 倍增益上限会截断低峰值段的目标增益——补测试固化该行为并单独验证
3. MP3 编码末块与 flush 的进度回调都发 1.0，破坏严格单调——增加 `lastReported` 守卫
4. 构建脚本图标路径拼接错误（`dist()` 助手误传两参）——修正为 `path.join`

### 📦 工程

- 单文件构建：`tools/build.js` 内联 CSS/JS/lamejs，复制 PWA 资源，纯 Node 生成 PNG 图标
- Capacitor 工程文件：`capacitor.config.json` + `package.json` 依赖（@capacitor 8.5.3）与 `cap:*` 脚本
- 在线部署：https://audio-merge-lab.app.workbuddy.host/

### 📝 文档体系

按 BOTW 存档实验室的仓库惯例组织：LICENSE（MIT + 附加声明）、THIRD-PARTY-NOTICES、CHANGELOG、使用说明.md、README（含第三方致谢与来源声明表）。
