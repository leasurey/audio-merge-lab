# 更新日志

本文件记录 **录音合并器（Audio Merge Lab）** 每个版本的变更。版本唯一权威值见 `src/audio-core.js` 的 `APP_VERSION`（`package.json` 的 `version` 与之保持一致）。

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
