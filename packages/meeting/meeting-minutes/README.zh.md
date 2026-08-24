# @deepseek-ai/dsh-meeting-minutes

[English](README.md) | 中文

用于浏览器录音并生成会议纪要的可选 Web profile 组合包。浏览器端在插件配置页贡献一张配置卡片，在输入框的工具行中占一个麦克风图标——旁边的工具抽屉里也会写出它的名称，打开会议纪要对话框即显示已存会议清单，可以录音（并可选择同时录制电脑内放的声音）或上传已有 MP4，展示处理进度，续跑或完整重新解析已存会议，并下载保留的原始录音、纯文本转写或最终 Markdown；Host 端把原始上传流式写入私有存储，原始文件不是 MP4 时才转换为 MP4/AAC，将音频切成 16 kHz 单声道 WAV 后通过 Qwen3-ASR-1.7B 顺序转写，再通过 `ctx.llm` 总结全量文字。本包不修改 `agent-loop`，也不会自动加入随附的 Web profile。

## 安装

先构建当前 checkout，再把组合包安装进 `web` profile，最后启动既有 Web 应用：

```bash
pnpm run build
pnpm dsh plugin --profile web add ./packages/meeting/meeting-minutes
pnpm dsh web
```

安装只会修改 `$DSH_HOME/profiles/web/package.json` 及该 profile 的依赖。移除命令为：

```bash
pnpm dsh plugin --profile web remove @deepseek-ai/dsh-meeting-minutes
```

`$DSH_HOME/settings.yaml` 与本插件的组合配置无关。标准 settings provider 只会在需要写入设置时延迟创建该文件；该文件不存在不会阻止本组合包加载。会议纪要应通过 profile 的 `$DSH_HOME/profiles/web/cordis.patch.yml` 配置，它会覆盖组合包提供的配置行。

## 本地 Qwen ASR

在 `pythonExecutable` 指定的 Python 环境中安装 `qwen-asr`：

```bash
python3 -m pip install -U qwen-asr
```

下载完整的 [Qwen3-ASR-1.7B](https://huggingface.co/Qwen/Qwen3-ASR-1.7B) 模型目录。只有一个权重分片不能运行模型：

```bash
python3 -m pip install -U huggingface_hub
hf download Qwen/Qwen3-ASR-1.7B \
  --local-dir "$HOME/.dsh/models/Qwen3-ASR-1.7B"
```

插件会在注册任何 HTTP 路由前检查以下文件：

```text
config.json
generation_config.json
chat_template.json
preprocessor_config.json
tokenizer_config.json
vocab.json
merges.txt
model.safetensors.index.json
model-00001-of-00002.safetensors
model-00002-of-00002.safetensors
```

Python 进程在第一个 ASR 分片到来时延迟启动，并在后续分片与会议之间常驻复用模型。该进程把整个模型保留在设备内存中，因此在没有分片处理的时间超过 `asrIdleShutdownMs`（默认五分钟）后会被终止；下一个分片重新启动进程并再次承担加载开销，所以在加载缓慢的主机上应调大该值，需要更早释放加速设备内存时调小它。它通过 `qwen-asr` 直接加载 Hugging Face 模型文件，本地推理路径不经过 Ollama。`localDevice: auto` 依次尝试 CUDA、Apple MPS 和 CPU；只有 `auto` 模式会在加速设备加载失败时转到 CPU，本地 ASR 绝不会自动转用远程 endpoint。Qwen 上游示例主要面向 CUDA，因此正式处理长会议之前，应先用短录音验证 MPS 的速度与内存占用。

## 配置

组合包默认值位于 [`cordis.patch.yml`](cordis.patch.yml)。profile 覆盖会替换该行的整个 `config`，因此必须重述该行需要的所有字段：

```yaml
- id: meeting-minutes
  config:
    storageRoot: /private/meeting-minutes
    asrMode: local
    localModelPath: /models/Qwen3-ASR-1.7B
    pythonExecutable: /path/to/python3
    localDevice: auto
    language: Chinese
    asrChunkSeconds: 300
    asrRequestTimeoutMs: 1800000
    asrIdleShutdownMs: 300000
    asrMaxOutputTokens: 2048
    remoteEndpoint: http://127.0.0.1:8000/v1/chat/completions
    remoteModel: Qwen/Qwen3-ASR-1.7B
    remoteApiKeyEnv: QWEN_ASR_API_KEY
    summaryMaxInputBytes: 65536
    summaryMaxOutputTokens: 4096
    summaryMaxReductionRounds: 8
    summaryRequestTimeoutMs: 600000
    maxUploadBytes: 2147483648
    listMaxMeetings: 200
    timeZone: Asia/Shanghai
```

`storageRoot` 默认是 `$DSH_HOME/meeting-minutes`，`localModelPath` 默认是 `$DSH_HOME/models/Qwen3-ASR-1.7B`，`listMaxMeetings` 限制历史清单返回的最新会议条数，`timeZone` 默认采用 Host 进程时区。不填写 `summaryProvider` 与 `summaryModel` 时使用当前默认 Agent 路由；同时填写这两个字段可固定独立的总结路由。`ffmpegExecutable` 可以覆盖包内 FFmpeg 二进制。

使用远程 Qwen ASR 服务时，将 `asrMode` 设为 `remote`，保留完整 endpoint 与 model 字段，并用 `remoteApiKeyEnv` 指定可选 bearer token 所在的环境变量。请求使用 `qwen-asr-serve`／vLLM 支持的 OpenAI 兼容 `/v1/chat/completions` 音频内容格式。远程调用失败会终止当前会议处理，不会自动启动本地推理。

## 设置卡片

组合包注册 `meeting-minutes` 设置命名空间，并在插件配置页贡献自己的卡片，因此存储目录与 ASR 路由不必改 `cordis.patch.yml` 就能修改。卡片编辑 `storageRoot`、`asrMode`、`language`、`localModelPath`、`pythonExecutable`、`localDevice`、`remoteEndpoint` 和 `remoteModel`，其余字段仍只能通过组合配置设置。

清空某个字段即恢复继承组合层；当解析后的配置是插件无法运行的组合时保存会被拒绝——`asrMode: local` 却指向不完整的模型目录，会直接报出缺失文件，而不是存下一个到下次启动才失败的值。

保存被接受后立即替换正在运行的安装：路由、处理运行时和常驻 ASR 进程全部按新配置销毁重建。正在处理的会议会被中止并记录为失败，与插件重载的结果一致；已保存的录音、转写和纪要不受影响。解析结果与当前运行配置相同的保存不会触发任何重建。

只有挂载了设置界面且 Host 服务该命名空间时才会渲染该卡片，因此没有插件配置页的部署仍然可以正常录音。

## 选择音源

录音区的两个控件决定一次录音采集什么。麦克风下拉菜单提供 **与系统相同设备**（默认，跟随操作系统当前使用的设备）、**不使用麦克风**，以及浏览器报告的每个麦克风。设备名称只有在麦克风权限被授予过之后才可见，因此下拉菜单在首次打开时请求权限；拒绝则只保留那两个固定条目。已保存的选择若对应设备已不存在，会回退到系统设备。两个控件的选择都会记入浏览器存储，下次录音沿用。

选择 **不使用麦克风** 且不录电脑内放时没有任何音源，此时录音被禁止，直到至少选择一个音源。

## 录制电脑内放的声音

录音默认只采集麦克风。开始录音前勾选 **同时录制电脑内放**，浏览器会额外请求一次带系统音频的屏幕共享，两路声音被混合成 `MediaRecorder` 写入的那一条音轨。本机播放的所有声音都会与现场声一起录下，包括任何浏览器标签页都够不到的原生会议客户端；未选择麦克风时则只录本机播放的声音。

用法：开始录音后在浏览器的选择器里选任意窗口或整个屏幕，并打开选择器自带的系统音频开关。共享必须保持到会议结束，因为音频挂在共享的视频轨上；插件不会录制画面。从浏览器横幅结束共享会停止录音并提交已录部分。

选择器上的系统音频开关属于浏览器而不是本插件，因此共享可能不带音轨。这种情况会直接报错并拒绝本次录音，而不是悄悄留下一段听不到任何远端发言的纯麦克风录音。外放加开麦还会让房间听见自己：麦克风回声消除保持开启，但耳机仍是可靠答案。

能否使用取决于浏览器：Chrome 与 Edge 提供该开关，macOS 上的支持随 Chrome 改用 ScreenCaptureKit 采集后到位，Windows 在共享整个屏幕时提供，Firefox 与 Safari 完全没有实现。没有该开关时，只能把虚拟回环设备选作麦克风输入。

## 文件与 HTTP 访问

一次录音会生成：

```text
<storageRoot>/<meeting-id>/
├── metadata.json
├── original.<browser-format>
├── audio.mp4                 # only when the original is not MP4
├── transcript.json
├── transcript.txt
├── transcript-progress.json   # only while transcription is unfinished
├── summary-requests.json
└── YYYY-MM-DD_HH-mm_<model-topic>_<minutes>m.md
```

文件和目录均以仅所有者可访问的权限创建。MP4 原始文件本身就是播放文件：FFmpeg 只转换其他容器格式，因此只有那时才会生成 `audio.mp4`。Markdown 先链接保留的浏览器原始录音，仅在存在转换产物时追加 `audio.mp4` 链接，再包含生成的纪要和不区分发言人的全量转写。文件名由会议日期、开始时间、模型主题和录音时长组成，时长向上取整到整分钟且不小于 1。主题中的路径字符会被替换，文件名中的主题最多保留 40 个 Unicode 字符；只有主题清理后为空时才使用 `未命名会议`，发生重名时追加短 meeting id。

路由族为 `/meeting-minutes/api`。它只接受回环 Host 和同源浏览器请求，因此通过局域网地址访问的 Web GUI 不能使用本插件。这是 DNS 重绑定与跨站请求防护，不是用户身份认证。上传会直接流式写盘，并在 `maxUploadBytes` 处停止；原始音频与标准化音频响应均支持字节范围请求。

| 方法与路径 | 用途 |
|---|---|
| `GET /meetings` | 按时间倒序的历史清单：id、阶段、显示名称与创建时间 |
| `POST /meetings` | 流式提交一次录音或选中的文件；`x-meeting-source-filename` 携带百分号编码的显示名称 |
| `GET /meetings/<id>` | 阶段、进度、转写、总结与产物可用性 |
| `DELETE /meetings/<id>` | 永久删除一个会议目录及其中全部产物 |
| `POST /meetings/<id>/retry` | 再次处理已完成或失败的会议；`?mode=restart` 表示完整重跑而不是续跑 |
| `GET /meetings/<id>/original` | 下载保留的浏览器原始录音 |
| `GET /meetings/<id>/audio` | 播放或下载 MP4 播放文件 |
| `GET /meetings/<id>/transcript` | 以纪要文件名下载纯文本转写 |
| `GET /meetings/<id>/minutes` | 下载最终 Markdown |

`transcript-progress.json` 保存已完成的 ASR 分片，全量转写发布后即被删除；被中断的转写正是靠它继续而不是从头再来。清单条目在生成总结后使用最终 Markdown 文件名，否则依次使用上传文件名和已存录音文件名。上传文件名只是显示用元数据：它不参与选择路径，磁盘文件仍使用由媒体类型决定的固定名称。Host 重启后遗留的非终态记录在清单中显示为失败，随后任意一次读取会把该状态写入持久记录。

## 生命周期

删除会议会移除整个目录，包括保留的原始录音；会议正在被处理队列占用时删除会被拒绝，浏览器也要求二次点击后才发送该请求。同一时刻只允许一个会议执行转换、ASR 与总结。只有持久状态为 `complete` 或 `failed` 且当前不活动的会议可以再次处理，且始终保留原始上传。同一会议的并发重试会返回冲突，重试也不会改变已经配置的本地或远程 ASR 目的地。插件释放时会先移除路由，随后中止活动请求体与模型调用，终止常驻 Python 进程，并等待重试接纳与完整任务链静止。Host 重启后首次读取尚未结束的 metadata 时，会把它持久化标记为可重试的失败状态。

再次处理分为续跑与完整重跑两种，会议状态本身给出它能提供哪一种。`resumeFrom` 给出续跑的起始阶段——全量转写已发布时为 `summarizing`，录音已转码或已有任一分片完成时为 `transcribing`——没有可复用产物时该字段不存在。续跑会复用已转码的 MP4、`transcript-progress.json` 中记录的每个 ASR 分片，以及 `summary-requests.json` 中的每一段中间摘要，因此只有失败的那一步及其之后的工作需要付出代价；WAV 分片属于临时产物，每次都重新切分。生成最终 JSON 的那次请求始终重新发起，因为它的输出还要通过解析。`?mode=restart` 会清除派生元数据、删除进度与审计文件并完整重跑；已完成的会议没有可续跑的失败阶段，因此得到的也是完整重跑。两种方式都会把旧主题的 Markdown 留在目录中，而 metadata 只指向本次新产物。

摘要复用按位置进行：新一次尝试的第 n 个请求，只有在系统指令与输入完全相同时才复用审计中的第 n 个请求，因此重新转写过的会议要重新支付全部摘要请求。

## 模型体验

### 分层会议总结

#### 模型看到什么

全量转写不超过 `summaryMaxInputBytes` 时，配置的总结路由会直接接收它。更长的转写会先拆成有界分段并生成 Markdown 摘要，再逐层归并，最后通过一次 JSON 请求生成 `topic` 与 `summaryMarkdown`。每次请求的完整系统指令、输入、路由、限制与输出都会保存到 `summary-requests.json`；转写被标记为不可信数据，不能改变指令层级。

#### Token 影响

每次总结都是独立的辅助模型请求。调用次数随转写长度增加；每次输入受 `summaryMaxInputBytes` 限制，输出受 `summaryMaxOutputTokens` 限制。续跑会重放上一次尝试已保存的中间摘要，只为失败的那次请求及其之后的请求消耗 token；完整重跑，以及重新转写过的会议，要为全部请求付费。归并后的组合输入必须比上一轮更小，超过 `summaryMaxReductionRounds` 轮仍无法完成时会失败，避免不合适的模型无限继续。录音、格式转换与 ASR 本身不直接消耗 LLM token。

#### KV Cache 影响

总结请求与 Agent 对话相互独立，各次总结请求之间也互不依赖。稳定的系统前缀可能被提供方缓存，但由数据决定的转写或归并内容会改变用户消息后缀；提供方是否缓存及何时淘汰不属于本包约定。

## 已知限制与延期工作

- **不区分发言人**：所有转写都是普通会议文字，插件不会虚构发言人身份。
- **只有粗粒度时间戳**：转写时间戳只标记固定 ASR 分片的起点；短语级或词级对齐需要独立的 forced-aligner 模型，目前未实现。
- **仅支持回环浏览器**：在 Web 界面拥有认证层或公开可复用的认证路由辅助函数之前，原始上传与下载路由会主动拒绝局域网 Host。
- **不在单个分片或请求内部续跑**：续跑从失败的那个 ASR 分片或摘要请求开始，而不会从某个分片或请求的中途继续。ASR 调用在最后一刻失败的分片仍要完整重转。
- **系统音频取决于浏览器**：插件只能请求一次带音频的共享。Firefox 与 Safari 从不提供，较旧的 Chrome 只在 Windows 与 ChromeOS 上提供。不存在既不依赖浏览器共享、也不依赖虚拟回环设备的 Host 侧采集路径。
- **录音期间共享一直可见**：录制电脑内放会让屏幕共享在整场会议中保持开启，浏览器会显示共享横幅，操作系统会显示共享指示。只有音频被录制，共享的画面从不被读取。
- **平台模型差异**：Qwen3-ASR 上游对 CUDA、MPS 与 CPU 的支持和性能不同。本包会校验文件并报告运行错误，但不能保证所有加速设备兼容。
