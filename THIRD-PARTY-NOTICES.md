# 第三方组件声明

| 组件 | 用途 | 许可 | 来源 |
|---|---|---|---|
| lamejs（`src/vendor/lame.min.js`） | MP3 编码 | LGPL-3.0 | [zhuker/lamejs](https://github.com/zhuker/lamejs) |
| mpg123-decoder（`src/vendor/mpg123-decoder.min.js`） | MP3 兜底解码（平台解码器失败时） | MIT | [eshaz/wasm-audio-decoders](https://github.com/eshaz/wasm-audio-decoders) → npm `mpg123-decoder@1.0.3` |
| aac-decoder（`src/vendor/aac-decoder.min.js`） | AAC/M4A 兜底解码（安卓平台解码丢帧时） | MIT（包裹层）+ 内含 faad2（**GPL-2.0**） | [eshaz/wasm-audio-decoders](https://github.com/eshaz/wasm-audio-decoders) → npm `@wasm-audio-decoders/aac@0.0.1` |

## lamejs

- **文件**：`src/vendor/lame.min.js`（LAME MP3 编码器的 JavaScript 移植）
- **上游仓库**：https://github.com/zhuker/lamejs
- **许可**：LGPL-3.0
- **完整性校验**：本文件经 GitHub 从官方仓库获取，git blob SHA-1 为
  `8dc6b0726388ff75bec69ac55ac5a6cc49e61093`，与上游一致（非自行计算）。
  重新获取后可用以下命令复核：

  ```text
  git hash-object src/vendor/lame.min.js
  ```

- **合规提示**：lamejs 为 LGPL-3.0。以本仓库成果分发时，需向接收方提供该
  组件的源码获取方式——本仓库通过保留上游链接满足此要求。若计划闭源商业
  分发，请咨询律师确认合规路径。

## mpg123-decoder

- **文件**：`src/vendor/mpg123-decoder.min.js`（取自 npm 包 `mpg123-decoder@1.0.3` 的
  `dist/mpg123-decoder.min.js`，UMD 构建，内含 base64 内联的 wasm）
- **上游仓库**：https://github.com/eshaz/wasm-audio-decoders
- **许可**：MIT（Copyright 2021-2025 Ethan Halsall）
- **用途**：仅在平台 `decodeAudioData` 失败且文件被识别为 MPEG 音频时启用，
  作为兜底解码路径；正常路径不加载其 wasm 实例
- **注意**：该文件包含一段经编码的内联 WebAssembly 体积（MP3 解码内核），
  这是其体积来源；构建时校验其不含 `<script` 序列以安全内联

## aac-decoder（faad2）

- **文件**：`src/vendor/aac-decoder.min.js`（取自 npm 包 `@wasm-audio-decoders/aac@0.0.1`
  的 `dist/aac-decoder.min.js`，UMD 构建，内含 yEnc 编码的 wasm）
- **上游仓库**：https://github.com/eshaz/wasm-audio-decoders（`src/aac`）
- **许可**：包裹层为 MIT（Copyright 2026 Ethan Halsall）；**解码内核 faad2 为 GPL-2.0**
- **用途**：安卓平台的 `decodeAudioData` 解 AAC 会随机丢帧（实测 54.36s 只解出 50.15s
  且不报错）。平台解码结果比媒体元素元数据时长短 3% 以上时，改用本解码器
  （MP4 解封装由 `audio-core.js` 的 `mp4ExtractAac` 完成，传入 ASC + 裸 AAC 帧）
- **⚠️ 许可注意**：faad2 为 GPL-2.0，**与 MIT 不同且具有传染性**。内联本解码器后，
  分发本应用（含单文件 HTML）时需向接收方提供对应源码获取方式（上游仓库与版本
  即可满足），且对该组件的许可义务按 GPL-2.0 执行。闭源分发前请咨询律师。
- **注意**：该文件包含一段经编码的内联 WebAssembly 体积（AAC 解码内核），
  这是其体积来源（约 232 KB）；构建时校验其不含 `<script` 序列以安全内联

## 应用图标

`dist/icons/` 下的 PNG 图标由 `tools/build.js` 在构建时用纯 Node（zlib）
程序化生成，无第三方素材，版权归本项目。
