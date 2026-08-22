# meeting/：会议录音与纪要

[English](README.md) | 中文

用于采集会议音频、完成转写，并发布持久会议产物或辅助实时通话的可选浏览器与 Host 插件。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`meeting-minutes/`](meeting-minutes/README.md) | 浏览器录音、Host 音频标准化、Qwen ASR、LLM 总结与 Markdown 下载 | 注册 Web 路由与 Client slot |
| [`live-assist/`](live-assist/README.md) | 仅采集对方的标签页音频、silero-vad 切分、实时 Qwen ASR 与流式建议回答 | 注册 Web upgrade 路由与 Client slot |
