# 雪儿 · ASI Presence

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 统一插件 `asi` 的**全息伴生桌面数字人外壳**（Electron + React 18 + TypeScript + Three.js + `@pixiv/three-vrm` + Silero VAD + Edge-TTS）。

角色名「**雪儿**」，灵感源自雪白忠诚、温柔亲近的小狗意象——默认采用「雪白冰青」全息视觉，在 **J.A.R.V.I.S. 万级粒子虚拟面孔（带雪白全息声学耳廓）** 与 **3D 赛博全息人形（支持拖拽 `.vrm` 换装）** 之间一键粒子拆解/重组切换。

## 核心能力（M1）

1. **三态双窗口联动**
   - **透明悬浮伴生窗**（`floating`）：无边框透明背景、空闲透明区域 OS 级点击穿透、可拖拽位置、随 ASI L0–L5 体征与 ToM 心智自动适应（你处于 `deep_focus` / `stuck_debugging` 时自动收缩降噪护航）。
   - **全息舞台大窗**（`stage`）：完整 3D 全息人形舞台、System One（Jev）实时决策 HUD、多标签 DSH 记忆/前瞻/做梦/稳态面板、拖拽本地 `.vrm` 模型热挂载。
   - **全局快捷键**：
     - `Cmd/Ctrl + Shift + Space`：呼出 / 隐身悬浮窗
     - `Cmd/Ctrl + Shift + A`：悬浮窗 ↔ 全息舞台大窗互切
     - `Cmd/Ctrl + Shift + M`：粒子拆解/重组切换形态（粒子面孔 ↔ 3D 全息人形）
     - `Cmd/Ctrl + Shift + X`：物理级一键静音断眼开关
2. **多脑区模型编排（`@asi/omni-router`）**
   - **System One 快直觉**：原生接入 TypeSafe AI Jev（`POST https://api.typesafe.ai/v1/systemone`，支持 `Choice` / `Score` / `Noul` / `Box`），Key 仅存本机 `~/.asi-presence/secrets.json`（`0600` 权限）；无 Key 或离线时无缝降级至本机 `magpie:3425` 结构化校准与本地启发式判定。
   - **快脑 / 视觉 / 慢脑**：默认直连本机 `http://127.0.0.1:3425/v1`（可一键拉取全部可用模型，并支持自定义 OpenAI / Anthropic / Gemini 兼容端点）。
3. **全双工语音与 60fps 口型同步**
   - 前端 **Silero VAD**（离线自动回退自适应 WebAudio VAD）实现毫秒级**随时开口打断**，并内置**扬声器防回声自打断保护**（雪儿发声期间提高打断概率、能量与持续帧门槛）。
   - macOS 开箱内置原生 **Apple Speech 语音识别**（`native/asi-speech-helper`，纯内存 `stdin` 流式传 WAV 绝不落盘，支持 `zh-CN`；同步兼容本地 Whisper HTTP 与浏览器 WebSpeech）。
   - 按句切分流式 TTS（开箱内置 Edge-TTS 免费神经中文 `zh-CN-XiaoyiNeural` + macOS 原生离线 `say` + 可配 OpenAI/FishSpeech/Kokoro 端点），口型与播报状态持续至 TTS 队列完整播毕。
   - WebAudio 频谱 + TalkingHead Viseme 60fps 实时驱动 3D 唇形与粒子声波脉冲。
4. **DSH `asi` 深度双向共生**
   - 自动发现 `~/.dsh/data/asi/presence-bridge.json`（`0600` 权限，仅 `127.0.0.1` 回环 + Bearer Token 鉴权）。
   - 实时同步 L0 体征、L1 稳态与求助卡、L2 `~/.dsh/data/asi/sleep/vault/` 长期记忆读写、L5 ToM/直觉闪回/前瞻提醒/DMN 做梦顿悟；DSH 未运行时优雅降级为独立本地陪伴模式。

## 在 macOS (Apple Silicon) 上启动

```bash
# 在仓库根目录安装依赖（macOS 上不要设置 ELECTRON_SKIP_BINARY_DOWNLOAD）
pnpm install

# 构建并启动雪儿桌面端
pnpm --filter asi-presence start
```

## 隐私与安全底线

- 屏幕视觉与摄像头**默认关闭**，开启时顶栏明确亮起呼吸灯，所有帧纯内存处理绝不落盘。
- 点击顶栏「一键断眼静音」或按下 `Cmd/Ctrl + Shift + X` 立即物理级切断麦克风、屏幕视觉、摄像头与语音播报。
- 所有凭据仅存储于 `~/.asi-presence/secrets.json`（`0600`），不读 `~/.secrets/`，前端不回显明文。
