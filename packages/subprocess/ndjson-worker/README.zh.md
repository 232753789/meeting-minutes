# @deepseek-ai/dsh-ndjson-worker

[English](README.md) | 中文

一个通过 stdio 使用换行分隔 JSON 通信的常驻子进程。`NdjsonWorker` 拥有插件本来需要自己手写的生命周期：首次使用时启动进程并在并发调用者之间共享同一次启动，从 stdout 逐行读取，向 stdin 每行写入一个 JSON 值，在拥有者报告已无未完成工作并经过 `idleShutdownMs` 后停止进程，并在释放时回收它。它抛出的每个错误都带有调用方的 `label`，因此诊断信息使用插件自己的词汇，而不是本包的。

行之上的协议属于调用方。`NdjsonWorkerHooks` 就是全部接缝：`onLine` 接收每一行 stdout，`onFailure` 报告进程死亡或 stdin 中断——由调用方决定这对其未完成的请求意味着什么——`isIdle` 回答空闲倒计时是否可以运行。

`dsh-meeting-minutes` 在其上驱动请求/响应协议，按 id 关联回复；`dsh-live-assist` 驱动事件流，把行路由到各会话的监听器。两者都在调用之间保持一个昂贵的模型常驻，而空闲倒计时正是为约束这一点而存在。

## Known Limitations and Deferred Work

- 仅支持文本行。需要交换二进制载荷的 worker 必须自行编码（当前两个调用方都把音频 base64 进 JSON），而非常大的载荷会在每条消息上都付出这份编码开销。
- 每个 worker 实例一个进程。没有进程池：需要并发的调用方要么像当前两个调用方那样串行使用一个进程，要么构造多个 worker。
- `onFailure` 只报告，不恢复。崩溃后是否重启由调用方决定，通过再次调用 `ensureStarted` 完成。
