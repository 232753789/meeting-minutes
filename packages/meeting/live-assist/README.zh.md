# @deepseek-ai/dsh-live-assist

[English](README.md) | 中文

面向实时会议辅助的可选 Web profile bundle。浏览器侧捕获一个共享浏览器标签页的音频，通过 loopback WebSocket 把 16 kHz PCM 流式送到 Host，并在对方转写下方渲染流式生成的建议回答；Host 侧用 silero-vad 切分这段音频，把以语法连接成分结尾的 VAD 最终片段先放入连续文本上下文，在得到稳定问题后交给常驻内存的本地 Qwen3-ASR 模型转写，判断是否需要作答，再通过 `ctx.llm` 流式生成回答——配置了深度路由时，另有一个模型给出第二个详细回答。全过程不写任何文件。它不修改 `agent-loop`，也不改动已发布的 Web profile。

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

1. 打开**面试助手**——它的耳机图标位于输入框的工具行中，旁边的工具抽屉会写出每个工具的名称——粘贴你的背景资料——简历、目标岗位、想强调的项目。资料保存在浏览器存储中，且只发送到本机。
2. 点击**开始监听**。监听就在你当前打开的这个会话里进行，不会另开会话。要让面试单独占一个会话，请先新建会话再开始——并在其中发一条消息，理由见下。在浏览器的共享选择器里选择运行会议的**标签页**，并打开「分享标签页音频」。整场会议保持共享开启。
3. 对话框关闭，输入框旁只留一行紧凑控制条：状态点、识别器当前状态、**暂停**、**结束**。其余空间全部留给会话。
4. 会话里首先出现的是你这次填写的背景资料全文，随后会话被命名。这两件事完成后才开始监听。监听期间可以切换到别的会话，识别器不受影响；转写与回答始终落在开始时那个会话里。
5. 对方每说完一句就作为一条消息出现，建议回答显示在它下面。视图跟随最新一轮滚动；向上滚动即停止跟随，与普通对话一致。

每个稳定问题都会得到属于自己的回答。VAD 仍然负责声音端点，但以「负责」或「如果」等连接成分结尾的片段会留在文本累加器中，直到下一段补全它。问号、明确的句末标点和显式的多问题标记会释放一个或多个问题。这个启发式方案不增加额外的 LLM 请求，因此模型仍只会看到一个稳定问题，回答按听到问题的先后逐个生成。

**配置了深度路由时会有两个回答。** `deepProvider` 与 `deepModel` 指定第二个模型，对同一个问题给出深度回答。是否需要作答仍然只由快速路判定：深度请求要等快速路认定这句话值得作答之后才发出，因此一句寒暄不会在它上面产生任何开销。此后两者同时运行、各自独立流式——简短回答先到，标为「要点」；详细回答在它下方生长，标为「详细」，分节给出问题背后的技术机制、简历中对应的经历、方案在什么条件下不再成立，以及面试官最可能追问的问题。两条路各自排队，因此一个慢的详细回答绝不会拖住下一个问题的简短回答。两项都不填时，插件仍然只发它一直在发的那一个请求。

本次监听所用的背景资料原样写进会话，作为它自己的一条消息。每个回答请求携带的正是这段文字，因此它不做截断也不做摘要：屏幕上看到的就是模型拿到的。

会话标题由同一条模型路由从这段背景资料生成，并在开始监听之前保存，因此会话从第一帧起就能在列表中辨认。代价是启动多等一次模型请求：这期间面板停在「正在连接…」，对方的话还没有被听。命名失败、模型给不出标题、或者没有 `sessionTitle` 服务时，会话保留默认名称并照常开始监听。

**在空白会话里开始监听前，先在其中发一条消息。** 会话是否「空白」由日志里有没有跑过 turn 决定，而本插件追加的事件都不开启 turn。因此一个装着整场面试的空白会话仍然是空白的：切走后它不出现在会话列表里，还会被下一次「新建会话」复用。内容并没有丢——它就在 `$DSH_HOME/sessions` 里——只是列表看不见它。设置对话框在当前会话为空白时会就此给出提示。

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

配置深度路由不改变上面任何一项：它的请求在快速路决定作答后才发出，与之并行流式，因此屏幕上第一个回答到达的时间和以前一样；详细回答按它自己模型的节奏稍后落地。

这张表只涵盖开始监听之后。启动本身另有一次开销：命名会话的那次请求会先跑完，由 `titleMaxOutputTokens` 限制，通常在一秒以内；第一句话还要额外承担识别器进程的模型加载时间。

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
    deepProvider: deepseek-official
    deepModel: deepseek-v4-pro
    deepReasoningEffort: max
    deepMaxOutputTokens: 4096
    deepRequestTimeoutMs: 300000
    answerMaxOutputTokens: 1600
    titleMaxOutputTokens: 64
    answerRequestTimeoutMs: 120000
    maxBackgroundBytes: 32768
    historyTurns: 8
    noteTurns: 6
    maxSessions: 2
    workerIdleShutdownMs: 300000
```

`localModelPath` 默认为 `$DSH_HOME/models/Qwen3-ASR-1.7B`。`vadThreshold` 是判定一个 512 采样窗口为语音的概率阈值。`minUtteranceMs` 度量的是不含 `vadSpeechPadMs` 补白的纯语音长度，因此一次短促的咳嗽会被丢弃而不是送去转写。`maxUtteranceMs` 会切断从不停顿的对方，使回答不至于被无限期拖住。识别之后，文本累加器会合并以少量连接短语结尾的片段，并拆分显式的多问题标记；它是确定性的启发式处理，不会再发起模型请求。`historyTurns` 是随请求一起作为上下文发送的历史问答条数，`noteTurns` 是你自己在会话中输入的、用来引导后续回答的最近消息条数。`titleMaxOutputTokens` 限制为会话命名的那一次请求。省略 `answerProvider` 和 `answerModel` 时使用当前默认 Agent 路由；两者同时提供则固定一条独立路由。`deepProvider` 与 `deepModel` 开启第二个详细回答，同样必须成对提供；`deepReasoningEffort` 依赖这两项，`deepMaxOutputTokens` 与 `deepRequestTimeoutMs` 只约束这一个请求——推理模型需要这两项都给得宽裕。不填这一对，就永远不会发出深度请求。

## 存储了什么

**面试内容会记录在会话日志中。** 每条转写和每条回答都是一个 session 事件（`live-assist/utterance`、`live-assist/answer-start`、`live-assist/answer-delta`、`live-assist/answer-end`、`live-assist/skipped`），三个 answer 事件都写明自己属于哪一条路，因此两个回答都能被完整重建，这段问答能在刷新后留存、出现在会话列表中、事后可回看——这正是把它放进会话的意义。它写在部署的 session 持久化所在位置，默认是 `$DSH_HOME/sessions`。

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

文本累加器释放的每个稳定问题对应一次请求。系统指令说明开头的 `SKIP`／`ANSWER` 控制行与回答格式：一句可以直接念出口的结论、3 到 5 条把结论落到简历中真实项目与目标岗位职责上的要点、以及一段以「延伸：」开头的指标、取舍或可能的追问；用户消息是一个 JSON 对象，携带面试者的背景资料、最近 `historyTurns` 条已回答的问题，以及转写出的这个问题。转写文本与背景资料都被框定为不可信数据，无法改变指令层级。判定默认作答：只有寒暄、单纯附和、面试官介绍公司或职位、以及听不清的残句才跳过；针对已答话题的追问一定作答，并且比上一轮更深入。面板、socket、识别器的任何信息都不会出现在请求中。

#### Token effect

在这条路上，每句发言是一次独立的辅助请求；一场会议大致产生与提问数相当的请求数。输出由 `answerMaxOutputTokens` 限制，被模型判为 `SKIP` 的发言在一个 token 后即停止。输入随背景资料增长（由 `maxBackgroundBytes` 限制）并随 `historyTurns` 增长。采集、切分与识别不产生 LLM token 开销。

#### KV Cache effect

回答请求既独立于 Agent 对话，彼此之间也相互独立。系统指令在整个会话中完全相同，可能被 provider 缓存，但用户消息随每句发言和每次追加的历史轮次而变化，因此可缓存前缀到此为止。provider 的缓存可用性与淘汰策略不在本包范围内。

### 针对同一句发言的详细回答

#### What the model sees

一次发往所配置深度路由的请求，只针对快速路已经判定要作答的发言发出；未配置 `deepProvider` 与 `deepModel` 时根本不会发出。系统指令说明判定已经完成、无需输出任何控制行，并要求分五节作答：直接回答、问题背后的技术机制、简历中对应经历按情境-任务-行动-结果展开、方案在什么条件下不再成立以及代价是什么、面试官最可能追问的两到三个问题。用户消息与快速路那次请求完全相同——背景资料、提问当时的历史问答、面试者输入的补充说明，以及这句发言——转写文本与背景资料在这里同样被框定为不可信数据。两条路都看不到对方的回答。

#### Token effect

配置深度路由会让一场面试的请求数大致翻倍，输出 token 则不止翻倍：`deepMaxOutputTokens` 默认 4096，而 `answerMaxOutputTokens` 是 1600，推理模型还要在此之上计费它的思考过程。输入是快速路输入的再来一遍，因此每个被作答的问题都要为背景资料和 `historyTurns` 付两次费用。被判为 `SKIP` 的发言在这里不产生任何开销，因为根本不会为它发出深度请求。

#### KV Cache effect

深度请求既独立于快速请求与 Agent 对话，彼此之间也相互独立。系统指令在整个会话中完全相同，可能被 provider 缓存，但用户消息随每句发言而变化，因此可缓存前缀到此为止，与快速路一致。

## Known Limitations and Deferred Work

- 如上所述，回答延迟的下界由整句识别决定；这不是实时字幕式的体验。
- 只有 Chromium 系浏览器能共享标签页音频，且只能触及基于浏览器的会议。
- 识别质量取决于 Qwen3-ASR 在短片段上的表现：多人抢话的群面转写效果明显差于一人一问的场景。
- Host 为每个插件在设备内存中持有一份模型。与 `dsh-meeting-minutes` 同时运行会加载两份权重。
- 携带本插件事件的会话无法被未安装该插件的构建重建，详见上文「存储了什么」。`Session.append` 没有提供把事件标记为可忽略的途径，因此这不是插件当前能规避的。
- 回答流按 delta 逐条写入日志，与 `assistant/chunk` 一致。因此一场长面试的日志会以回答片段为主体。
- 回答是串行的，因此连续提问会让靠后的回答变慢。累加器只会合并符合连接成分和边界规则的片段；不常见的说法仍可能被切开，或要等到下一段稳定片段才释放。
- 配置深度路由会让一场面试的模型请求数翻倍，而且它的回答在自己的一条路上排队：连续三个问题会让第三个详细回答姗姗来迟，尽管它的简短回答按时到达。
- 命名需要 `sessionTitle` 服务。没有它时会话保留默认名称，也不会发出标题请求。
- 本插件追加的任何事件都不会清除会话的 blank 位，而那个位仅由 `turn/start` 推导。记录在空白会话里的面试因此不进入会话列表，还会被下一次「新建会话」复用；对话框会给出提示，但真正的修复属于超出本 bundle 的会话词汇表改动。
