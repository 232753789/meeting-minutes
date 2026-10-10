# meeting-minutes/ — 浏览器录音会议纪要

[English](README.md) | 中文

一个面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的自成一体的可选插件项目：一个可安装的 Web profile 组合包。它在浏览器中录制会议（麦克风，可选择同时混入电脑内放的声音）或接收上传的 MP4，用本地或远程 Qwen3-ASR-1.7B 转写——可选地用本地 pyannote pipeline 区分说话人——再通过 Harness 的 LLM 路由把转写总结为可下载的 Markdown 会议纪要。它不依赖任何其他插件。

| 包 | 职责 | ctx key |
|---|---|---|
| [`meeting-minutes/`](meeting-minutes/README.zh.md) | 浏览器录音与历史记录、私有录音存储、FFmpeg 标准化、Qwen ASR、说话人分离与 Markdown 纪要 | 注册 Web 路由、一个 `conversation.input.tool` 条目、一张 `settings.plugin.item` 卡片和 `meeting-minutes` settings 命名空间 |

## 构建

```bash
cd meeting-minutes
pnpm install
pnpm run build
```

## 注册到 DeepSeek Harness

在 DeepSeek Harness 仓库根目录下执行：

```bash
git clone https://github.com/232753789/meeting-minutes packages/meeting-minutes
(cd packages/meeting-minutes/meeting-minutes && pnpm install && pnpm run build)
pnpm dsh plugin --profile web add ./packages/meeting-minutes/meeting-minutes
pnpm dsh web
```

使用已安装的 `dsh` 时，直接传入已构建的包目录路径：

```bash
dsh plugin --profile web add /path/to/meeting-minutes/meeting-minutes
dsh web
```

用 `pnpm dsh plugin --profile web remove @deepseek-ai/dsh-meeting-minutes` 移除。模型准备、配置项与 HTTP 接口见[包 README](meeting-minutes/README.zh.md)。
