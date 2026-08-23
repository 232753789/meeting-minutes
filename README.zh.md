# DeepSeek Harness 会议插件

[English](README.md) | 中文

[`packages/meeting/`](packages/meeting/README.md) 下的两个可选 Web profile 组合包在你自己的机器上把会议音频变成文字：[`meeting-minutes`](packages/meeting/meeting-minutes/README.md) 录制或导入一场完整会议并发布 Markdown 纪要，[`live-assist`](packages/meeting/live-assist/README.md) 在通话进行中监听，为对方问出的每个问题流式生成建议回答。两者都通过本地 Qwen3-ASR 模型转写，通过 harness 自身的 `ctx.llm` 路由生成总结或回答，都安装进已有的 `web` profile，不修改 `agent-loop`，也不改动已发布的 profile。

## 运行

安装 `Node.js`，然后启动 Web 应用：

```bash
npx @deepseek-ai/dsh web
```

该命令默认在 `http://127.0.0.1:3080` 提供 Web UI。两个会议组合包都从本仓库的工作副本安装，因此下面每一步都以源码路径为准。

### 从源码运行

```bash
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
```

随后 `pnpm dsh web` 会从该工作副本启动同一个 Web 应用。每个组合包各自的安装命令在下面各自的章节中。

### Python 依赖与 ASR 模型

把 Python 包装进你将在 `pythonExecutable` 中指定的解释器。`meeting-minutes` 只需要 `qwen-asr`；`live-assist` 还需要 `silero-vad`：

```bash
python3 -m pip install -U qwen-asr silero-vad
```

下载完整的 [Qwen3-ASR-1.7B](https://huggingface.co/Qwen/Qwen3-ASR-1.7B) 模型目录。单个权重分片不是可运行的模型：

```bash
python3 -m pip install -U huggingface_hub
hf download Qwen/Qwen3-ASR-1.7B --local-dir "$HOME/.dsh/models/Qwen3-ASR-1.7B"
```

两个插件都会在注册任何路由之前检查该目录的文件清单，也都可以共用同一个目录——但各自仍会在设备内存中持有一份自己的权重。`localDevice: auto` 依次尝试 CUDA、Apple MPS、CPU。

### 浏览器支持

录制电脑自身音频与捕获标签页音频都是 Chromium 系浏览器的能力：请使用 Chrome 或 Edge。Firefox 与 Safari 都没有实现。

## `meeting-minutes`——把会议录音变成 Markdown 纪要

### 功能

- 在浏览器中录制麦克风，可选择混入电脑自身的音频输出，也可以直接上传已有的 MP4。
- 把原始录音流式写入私有存储，非 MP4 容器转码为 MP4/AAC，并按顺序把 16 kHz 单声道分块交给 Qwen3-ASR 转写。
- 通过 `ctx.llm` 总结完整转写，单次请求装不下的转写按有上限的轮次归约，并发布带日期的 Markdown，其中包含主题、纪要与完整转写。
- 保留会议历史，可重新打开、从保留的原始录音重新处理、下载或删除。
- 在插件配置页贡献自己的卡片，因此改存储目录与 ASR 路由无需改 YAML。

### 安装与运行

```bash
pnpm dsh plugin --profile web add ./packages/meeting/meeting-minutes
pnpm dsh web
```

安装只改动 `$DSH_HOME/profiles/web/package.json` 及其依赖。卸载用 `pnpm dsh plugin --profile web remove @deepseek-ai/dsh-meeting-minutes`。

### 使用方法

1. 打开输入框中的**会议纪要**控件，它以存储的会议历史作为首屏。
2. 选择麦克风——默认是**与系统相同设备**，也可以选**不使用麦克风**——当远端声音来自浏览器标签页无法触及的原生会议客户端时，打开**同时录制电脑内放**。
3. 开始录制。启用电脑音频后浏览器会请求一次屏幕共享：选择任意窗口或整个屏幕，打开选择器自带的系统音频开关，并让共享在整场会议期间保持开启。只录制音频，共享的视频永远不会被读取；到达时没有音频轨的共享会被拒绝，而不是被静默当作缺失全部远端人声的纯麦克风录音保留下来。
4. 停止录制，或者改为上传已有的 MP4。处理依次经过标准化、ASR 与总结，同一时刻只处理一场会议。
5. 下载保留的原始录音、纯文本转写或最终 Markdown。**重新解析**会把已完成或已失败的会议从保留的原始录音重跑一遍。

请戴耳机：外放加上开着的麦克风会让房间听见自己。

一次录制产生 `metadata.json`、保留的原始录音、原始文件不是 MP4 时的 `audio.mp4`、`transcript.json`、`transcript.txt`、`summary-requests.json`，以及 `YYYY-MM-DD_HH-mm_<主题>_<分钟数>m.md`，全部位于 `$DSH_HOME/meeting-minutes/<meeting-id>/` 下，权限仅限属主。路由族 `/meeting-minutes/api` 只接受 loopback 的 Host 值与同源浏览器请求，因此通过局域网地址访问的 Web GUI 用不了这个插件。

## `live-assist`——为实时通话给出建议回答

### 功能

- 捕获一个共享浏览器标签页的音频，通过 loopback WebSocket 把 16 kHz PCM 流式送到 Host。它从不打开麦克风。
- 用 silero-vad 切分这段音频，把每个完整语句交给常驻的本地 Qwen3-ASR 进程转写，并判断这句话是否需要作答。
- 通过 `ctx.llm` 流式生成建议回答，请求中带上你粘贴的背景资料与最近若干个已作答的问题作为上下文。
- 把每条转写与每个回答追加到你发起时所在的会话，因此刷新后仍在，事后也可以回看。音频永远不会写入磁盘。

### 为什么只有对方进入转写

这种隔离是物理的，而非统计推断：对方的声音由会议网页播放，落在被捕获的标签页音频里；你自己的声音从麦克风直接进入会议客户端的上行通道，不经过标签页的输出。这里不涉及说话人分离，也不需要。

### 安装与运行

```bash
pnpm dsh plugin --profile web add ./packages/meeting/live-assist
```

**启动前先完成配置。** 插件在 plugin tree 加载期间校验模型目录，因此 `localModelPath` 不是一个完整模型目录时，失败的是整个应用的启动，而不只是这个组合包。除非模型确实位于 `$DSH_HOME/models/Qwen3-ASR-1.7B` 且 `PATH` 上的 `python3` 已装好两个 Python 包，否则请在 `$DSH_HOME/profiles/web/cordis.patch.yml` 中加一行 `live-assist` 写明你自己的路径，然后再启动 Web 应用：

```bash
pnpm dsh web
```

卸载用 `pnpm dsh plugin --profile web remove @deepseek-ai/dsh-live-assist`。

### 使用方法

1. 打开输入框中的**面试助手**控件，粘贴你的背景资料——简历、目标岗位、值得强调的项目。它保存在浏览器存储中，且只发往本机。
2. 点击**开始监听**。监听就在你当前打开的这个会话里进行，不会另外创建会话。想让面试独占一个会话，请先创建并在其中发一条消息：这个插件追加的任何内容都不会清除会话的空白标记，因此承载着整场面试的空白会话仍然不会出现在会话列表中。
3. 在浏览器的共享选择器中选择正在开会的那个**标签页**，打开 *分享标签页音频*，并让共享在整场通话期间保持开启。共享整个屏幕会让对方看到这个面板；只共享一个标签页才能保证它是私有的。
4. 你的材料先完整地进入会话，会话在开始监听之前据此命名。此后对方每说一段话都会作为一条消息到达，其建议回答位于消息下方。
5. **暂停**在你说话时不再把音频送给识别器。**结束**关闭共享；会话保留，可以从会话列表重新打开。

每一句话都有自己的回答，按听到问题的先后逐个生成，因此连续追问会让靠后的回答变慢。请戴耳机：外放时会议客户端的回声消除会对房间声学做出反应，让识别器拿到的音频变差。

### 延迟与落盘内容

| 阶段 | 典型耗时 |
|---|---|
| 判定一句话结束所需的尾部静音（`vadMinSilenceMs`） | 700 ms |
| Qwen3-ASR 处理一句短语句 | 500–1500 ms |
| `ctx.llm` 的第一个回答 token | 约 500 ms |

从对方说完一句到回答的第一批文字出现，大致间隔两秒到两秒半。启动另有开销：为会话命名的那次请求会先跑完，而第一句话还要额外承担识别器进程的模型加载。

每条转写与每个回答都是一个会话事件，写入部署的会话持久化位置，默认在 `$DSH_HOME/sessions` 下。真正用于面试之前有两点值得知道：对方说的任何内容都会以明文留在磁盘上，直到你删除那个会话；未安装本组合包的构建会拒绝重建包含这些事件的会话。

## 配置

每个组合包的默认值都在各自的 `cordis.patch.yml` 中。`$DSH_HOME/profiles/web/cordis.patch.yml` 中的 profile 覆盖会整体替换该行的 `config`，因此需要重述这一行所需的每个字段；完整示例行见 [`meeting-minutes`](packages/meeting/meeting-minutes/README.md) 与 [`live-assist`](packages/meeting/live-assist/README.md)，那里同时说明了每个字段、HTTP 接口与已知限制。

多数部署会改的字段是：两个组合包共有的 `localModelPath`、`pythonExecutable`、`localDevice`、`language`；`meeting-minutes` 的 `storageRoot`、`asrChunkSeconds` 与 `asrMode: remote` 的端点字段；以及 `live-assist` 的 `vadMinSilenceMs`、`historyTurns`、`answerMaxOutputTokens`。省略 `summaryProvider`/`summaryModel` 与 `answerProvider`/`answerModel` 这两对字段时使用当前默认的 Agent 路由；同时给出一对中的两个字段则固定一条独立路由。

`meeting-minutes` 还可以从设置卡片编辑 `storageRoot`、`asrMode`、`language`、`localModelPath`、`pythonExecutable`、`localDevice`、`remoteEndpoint` 与 `remoteModel`。卡片中留空的字段重新继承组合层；解析结果是插件跑不起来的配置时保存会被拒绝；被接受的保存会一次性重建路由、处理运行时与 ASR worker。

## 许可证

[MIT](LICENSE)。第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
