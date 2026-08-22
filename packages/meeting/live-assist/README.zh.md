# @deepseek-ai/dsh-live-assist

[English](README.md) | 中文

面向实时会议辅助的可选 Web profile bundle。浏览器侧捕获一个共享浏览器标签页的音频，通过 loopback WebSocket 把 16 kHz PCM 流式送到 Host，并在对方转写旁边渲染流式生成的建议回答；Host 侧用 silero-vad 切分这段音频，把每个完整语句交给常驻内存的本地 Qwen3-ASR 模型转写，判断这句话是否需要作答，再通过 `ctx.llm` 流式生成回答。全过程不写任何文件。它不修改 `agent-loop`，也不改动已发布的 Web profile。

## 为什么只有对方进入转写

这个插件从不打开麦克风。它捕获的是共享标签页播放出来的声音，这种隔离是物理的，而非统计推断：

- 对方的声音由会议网页播放，因此落在被捕获的标签页音频里。
- 你自己的声音从麦克风直接进入会议客户端的上行通道，不经过标签页的输出，因此不可能出现在转写中。

这里不涉及说话人分离，也不需要。请戴耳机：外放时会议客户端的回声消除会对房间声学做出反应，让识别器拿到的音频变差。

## 安装

构建当前工作副本，把 bundle 安装进 `web` profile：

```bash
pnpm run build
pnpm dsh plugin --profile web add ./packages/meeting/live-assist
```

**启动前先完成配置。** 插件在 plugin tree 加载期间校验模型目录，因此 `localModelPath` 不是一个完整模型目录时，失败的是整个应用的启动，而不只是这个 bundle：

```text
dsh: plugin tree failed to load: failed to apply loader entry live-assist
(@deepseek-ai/dsh-live-assist): live-assist: localModelPath is not a directory: …
```

对于配置错误的插件，这是刻意的响亮失败，但也意味着首次启动前默认路径就必须正确。除非你的模型确实位于 `$DSH_HOME/models/Qwen3-ASR-1.7B` 且 `PATH` 上的 `python3` 已装好两个 Python 包，否则请在 `$DSH_HOME/profiles/web/cordis.patch.yml` 中加入一行 `live-assist`，写明你自己的路径——完整的行见下方「配置」一节——然后再启动已有的 Web 应用：

```bash
pnpm dsh web
```

卸载：

```bash
pnpm dsh plugin --profile web remove @deepseek-ai/dsh-live-assist
```

## Python 依赖

把两个包装进 `pythonExecutable` 指向的 Python 环境：

```bash
python3 -m pip install -U qwen-asr silero-vad
```

下载完整的 [Qwen3-ASR-1.7B](https://huggingface.co/Qwen/Qwen3-ASR-1.7B) 模型目录。单个权重分片不是可运行的模型：

```bash
python3 -m pip install -U huggingface_hub
hf download Qwen/Qwen3-ASR-1.7B --local-dir "$HOME/.dsh/models/Qwen3-ASR-1.7B"
```

插件在注册 socket route 之前会检查与 [`dsh-meeting-minutes`](../meeting-minutes/README.md) 相同的文件清单，目录不完整时拒绝加载。两个插件可以共用同一个模型目录，但各自运行独立进程，在设备内存中各持有一份权重。

## 使用

1. 打开输入框中的**面试助手**控件，粘贴你的背景资料——简历、目标岗位、想强调的项目。资料保存在浏览器存储中，且只发送到本机。
2. 点击**开始监听**。当前会话已有对话时，会先新建一个 dsh 会话并立即切换过去，因此面试内容不会落进你原本打开的那个对话；当前是空白会话时就地开始，因为「新建会话」本来也只会回到这个会话。在浏览器的共享选择器里选择运行会议的**标签页**，并打开「分享标签页音频」。整场会议保持共享开启。
3. 对话框关闭，输入框旁只留一行紧凑控制条：状态点、识别器当前状态、**暂停**、**结束**。其余空间全部留给会话。
4. 对方每说完一句就作为一条消息出现，建议回答显示在它下面。视图跟随最新一轮滚动；向上滚动即停止跟随，与普通对话一致。

每一句都会得到属于自己的回答。回答按听到问题的先后逐个生成，新问题绝不会取消正在生成的那一个——识别器按静音切分，句中停顿会让一句话提前结束，取消将丢弃真正问题的回答，只留下紧随其后的残句。代价是回答会排队：对方连问三件事，第三个回答要等前两个。

会话标题由同一条模型路由从你的背景资料生成，因此不打开也能在会话列表中辨认。命名不会拖慢监听——标题请求还在途中时音频已经在流动，命名失败的会话保留默认名称。

**暂停**在不结束会话的前提下停止向识别器转发音频——轮到你说话时用它。**结束**关闭共享；会话保留，可从会话列表重新打开。

共享选择器里的音频开关属于浏览器而非本插件，因此共享可能不带音频轨。这种情况会明确报错并拒绝会话，而不是静默地监听一段没有声音的流。

如果你正在向对方共享**整个屏幕**，这个面板对方是看得见的。只有共享单个窗口或标签页才能保证它不外泄。

## 延迟

Qwen3-ASR 确实支持流式推理，但仅限 vLLM 后端，而 vLLM 在 macOS 上无法运行。因此本插件使用 transformers 后端，按完整语句转写，这决定了延迟的构成：

| 阶段 | 典型耗时 |
|---|---|
| 判定语句结束所需的尾部静音（`vadMinSilenceMs`） | 700 ms |
| Qwen3-ASR 处理一个短语句 | 500–1500 ms |
| `ctx.llm` 的首个回答 token | 约 500 ms |

从对方说完一句话到回答的第一个字出现，大约经过两秒到两秒半。调小 `vadMinSilenceMs` 可以缩短这段时间，代价是对方思考停顿时会被中途切断。识别器进程在语句之间保持常驻，因此模型加载成本只付一次；没有会话超过 `workerIdleShutdownMs` 后释放。

## 浏览器支持

标签页音频捕获需要 Chrome 或 Edge；Firefox 和 Safari 未实现该能力。原生会议客户端（Zoom 或腾讯会议桌面版）不通过任何浏览器标签页播放音频，因此这里够不着——捕获它们需要把虚拟环回设备（macOS 上的 BlackHole、Windows 上的 VB-Cable）选作输入设备，本插件不做这件事。

## 配置

bundle 默认值在 [`cordis.patch.yml`](cordis.patch.yml)。profile 覆盖会替换该行完整的 `config`，因此需要重述这一行需要的每个字段：

```yaml
- id: live-assist
  config:
    localModelPath: /models/Qwen3-ASR-1.7B
    pythonExecutable: /path/to/python3
    localDevice: auto
    language: Chinese
    asrMaxOutputTokens: 256
    vadThreshold: 0.5
    vadMinSilenceMs: 700
    vadSpeechPadMs: 200
    minUtteranceMs: 400
    maxUtteranceMs: 20000
    answerMaxOutputTokens: 800
    titleMaxOutputTokens: 64
    answerRequestTimeoutMs: 120000
    maxBackgroundBytes: 32768
    historyTurns: 8
    noteTurns: 6
    maxSessions: 2
    workerIdleShutdownMs: 300000
```

`localModelPath` 默认为 `$DSH_HOME/models/Qwen3-ASR-1.7B`。`vadThreshold` 是判定一个 512 采样窗口为语音的概率阈值。`minUtteranceMs` 度量的是不含 `vadSpeechPadMs` 补白的纯语音长度，因此一次短促的咳嗽会被丢弃而不是送去转写。`maxUtteranceMs` 会切断从不停顿的对方，使回答不至于被无限期拖住。`historyTurns` 是随请求一起作为上下文发送的历史问答条数，`noteTurns` 是你自己在会话中输入的、用来引导后续回答的最近消息条数。`titleMaxOutputTokens` 限制为会话命名的那一次请求。省略 `answerProvider` 和 `answerModel` 时使用当前默认 Agent 路由；两者同时提供则固定一条独立路由。

## 存储了什么

**面试内容会记录在会话日志中。** 每条转写和每条回答都是一个 session 事件（`live-assist/utterance`、`live-assist/answer-start`、`live-assist/answer-delta`、`live-assist/answer-end`、`live-assist/skipped`），因此这段问答能在刷新后留存、出现在会话列表中、事后可回看——这正是把它放进会话的意义。它写在部署的 session 持久化所在位置，默认是 `$DSH_HOME/sessions`。

音频不会被存储。它在内存中解码并以数组形式交给模型；任何录音都不会写盘。背景资料存放在浏览器自己的本地存储中，且只发送到本机。

在真实面试中使用前，有两个后果值得知道：

- 对方说的任何话都以明文形式留在磁盘上，直到你删除那个会话。
- 这些事件类型由本可选 bundle 贡献。未安装它的构建会拒绝重建包含这些事件的会话，因此移除插件会使过去的面试会话变得**不可读**，而不只是不渲染。这与其他所有可选插件的事件（`tool-workflow`、`web-search`）遵循同一规则。

## HTTP 接口

一条 WebSocket route：`/live-assist/socket`，以 upgrade route 注册在 Host web server 上。除非 `Host` 头指向 loopback 授权方，且浏览器提供的 `Origin`（若有）与之匹配，否则拒绝升级——WebSocket 升级不受 CORS 保护，这项检查是恶意页面与这条 socket 上的实时音频之间唯一的屏障。二进制帧承载 16 kHz 小端 16 位单声道 PCM；文本帧承载 [`src/protocol.ts`](src/protocol.ts) 中声明的控制消息。

转写与回答不走这条 socket。浏览器在 `start` 消息中指明承载这场面试的会话，Host 把每条结果追加到该会话，因此对话是它们的唯一来源，刷新不会丢失任何内容。

## 测试

TypeScript 部分由仓库的 `pnpm run test` 覆盖。worker 的语句切分逻辑在 [`python/test_segmenter.py`](python/test_segmenter.py) 中针对 silero-vad 的脚本化替身单独测试；这些测试只需要 numpy，不属于仓库的测试 lane：

```bash
python3 -m pytest packages/meeting/live-assist/python
```

## Model Experience

### 针对一句对方发言的建议回答

#### What the model sees

识别器判定为完整的每一句发言对应一次请求。系统指令说明回答格式与开头的 `SKIP`／`ANSWER` 控制行；用户消息是一个 JSON 对象，携带面试者的背景资料、最近 `historyTurns` 条已回答的问题，以及转写出的这句发言。转写文本与背景资料都被框定为不可信数据，无法改变指令层级。面板、socket、识别器的任何信息都不会出现在请求中。

#### Token effect

每句发言是一次独立的辅助请求；一场会议大致产生与提问数相当的请求数。输出由 `answerMaxOutputTokens` 限制，被模型判为 `SKIP` 的发言在一个 token 后即停止。输入随背景资料增长（由 `maxBackgroundBytes` 限制）并随 `historyTurns` 增长。采集、切分与识别不产生 LLM token 开销。

#### KV Cache effect

回答请求既独立于 Agent 对话，彼此之间也相互独立。系统指令在整个会话中完全相同，可能被 provider 缓存，但用户消息随每句发言和每次追加的历史轮次而变化，因此可缓存前缀到此为止。provider 的缓存可用性与淘汰策略不在本包范围内。

## Known Limitations and Deferred Work

- 如上所述，回答延迟的下界由整句识别决定；这不是实时字幕式的体验。
- 只有 Chromium 系浏览器能共享标签页音频，且只能触及基于浏览器的会议。
- 识别质量取决于 Qwen3-ASR 在短片段上的表现：多人抢话的群面转写效果明显差于一人一问的场景。
- Host 为每个插件在设备内存中持有一份模型。与 `dsh-meeting-minutes` 同时运行会加载两份权重。
- 携带本插件事件的会话无法被未安装该插件的构建重建，详见上文「存储了什么」。`Session.append` 没有提供把事件标记为可忽略的途径，因此这不是插件当前能规避的。
- 回答流按 delta 逐条写入日志，与 `assistant/chunk` 一致。因此一场长面试的日志会以回答片段为主体。
- 回答是串行的，因此连续提问会让靠后的回答变慢。被识别器从句中切开的语句不会被合并，尾部残句会作为独立问题得到回答；调大 `vadMinSilenceMs` 是缓解这一点的粗糙办法。
- 命名需要 `sessionTitle` 服务。没有它时会话保留默认名称，也不会发出标题请求。
