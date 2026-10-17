# 维护者笔记（Maintainer Notes）

> 本文件存放从 README 移出的开发期资料：生态调研、维护者工具、移动端系统边界设计。
> 面向使用者的信息请看 [README](../README.md)。

## GitHub 生态调研结论（2026-10-17 检索）

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

### 本机 git 推送排障（2026-10-18 定位）

推送被断时按层排查，本机是**三个因素叠加**：

1. 环境挂着本地代理（`HTTP_PROXY/HTTPS_PROXY=127.0.0.1:<port>`），会干扰 TLS
2. 便携版 git 的 schannel 吊销检查失败（`CRYPT_E_NO_REVOCATION_CHECK`），单加 `http.schannelCheckRevoke=false` 无效（代理仍在）
3. **github.com / api.github.com / github.io 等整个 github 域在 hosts 里被 SteamTools（Watt Toolkit 加速器）劫持到 127.0.0.1**——"网络加速"就是它，TLS 证书由 SteamTools 签发（`issuer: CN=SteamTools Certificate; O=BeyondDimension`），其根证书装在 Windows 信任库

可用的推送组合（证书链与主机名仍完整校验，只跳过在此网络必然失败的 CRL 吊销查询）：

```bash
git -c http.sslBackend=schannel -c http.schannelCheckRevoke=false \
    -c http.proxy= -c https.proxy= push origin main
```

另一条验证通道：Node（自带 Mozilla CA）可直连 api.github.com，用于线上内容核验；`tls.rootCertificates`（144 个）也可导出为 PEM 给 openssl 后端当 CA 库。注意 github.io 被劫持且 SteamTools 本地服务不代理它，**本机无法验证 Pages 页面**，需改走 GitHub API。

## 移动端系统边界与"绕法"（设计原则）

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

### Capacitor 打包注意事项

`cap add` 不会自动添加的配置：

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

注意：Capacitor 的 WKWebView 里 `a[download]` 行为与浏览器不同，导出文件建议后续接 `@capacitor/filesystem` + `@capacitor/share` 插件（当前以浏览器分享/下载为主）。
