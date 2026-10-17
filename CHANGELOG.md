# 更新日志

本文件记录 **录音合并器（Audio Merge Lab）** 每个版本的变更。版本唯一权威值见 `src/audio-core.js` 的 `APP_VERSION`（`package.json` 的 `version` 与之保持一致）。

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
