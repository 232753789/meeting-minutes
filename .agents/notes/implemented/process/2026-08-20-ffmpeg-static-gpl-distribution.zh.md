# Agent Note: 把 GPL 版 FFmpeg 二进制作为经审阅的分发决策随包发布

Status: implemented

[English](2026-08-20-ffmpeg-static-gpl-distribution.md) | 中文

## 问题

`@deepseek-ai/dsh-meeting-minutes` 把 `ffmpeg-static` 声明为运行时依赖：该包安装一个预编译的 FFmpeg 可执行文件，用于把上传转换为 MP4/AAC 并切出 ASR 所需的 WAV 分片。该包声明的许可证是 `GPL-3.0-or-later`，因为它安装的二进制是 FFmpeg 的 GPL 构建。

[`gen-third-party-notices`](../../../../scripts/gen-third-party-notices.ts) 拒绝为任何非宽松许可的运行时依赖生成声明文件，而 pre-commit 钩子会运行它，因此该插件根本无法提交。这个拒绝是刻意的：copyleft 许可证进入随产品分发的面属于分发决策，生成器不会默默吸收。在本记录之前，唯一被授权的身份是官方 Claude Agent SDK，那是一次所有者授权，而不是他人可遵循的可审阅规则。

## 决策

项目所有者审阅了条款，接受随包分发 GPL 版 FFmpeg 可执行文件。`ffmpeg-static` 被记入生成器中以包名为键的 `AUTHORIZED_COPYLEFT_RUNTIME`，其值陈述该条目所承担的义务。该表就是决策记录；它不改变许可证的性质，`THIRD_PARTY_NOTICES.md` 会在依赖表旁逐条披露每个条目及其义务。

该决策依据的事实：

- **独立进程，而非链接。** 插件通过 `ctx.subprocess.spawn` 以可执行文件方式运行 FFmpeg，不链接其任何代码，因此本仓库的 MIT 源码仍为 MIT。
- **义务随二进制传递。** 任何随附该可执行文件的分发物都要承担其 GPL 义务，包括提供对应源码；源码是 [FFmpeg](https://github.com/FFmpeg/FFmpeg)，二进制则是 `ffmpeg-static` 文档所记录的第三方静态构建。
- **已有替代通道。** `ffmpegExecutable` 可以让插件指向单独安装的 FFmpeg，不希望随包携带该二进制的部署可以自行配置。

将来出现新的非宽松运行时依赖时，仍需所有者做出新的决策，本条目不构成先例：每一次加入该表都要陈述自身的义务。

## 考虑过的替代方案

- **移除 `ffmpeg-static`，要求配置外部 FFmpeg。** 暂不采用：这样能把 GPL 二进制从分发物中去掉，但每个使用该插件的用户都必须先自行安装 FFmpeg 才能完成第一次录音，等于用一次全新安装即失败换掉一条已记录的许可证义务。
- **放宽生成器，允许任意 copyleft 运行时依赖。** 否决：该门禁的存在正是为了强制这次审阅。全面放行会让下一个 copyleft 依赖在无人记录谁接受了什么的情况下进入。
- **本次提交绕过钩子。** 否决：声明文件在测试通道中被逐字节断言，绕过只会产生过期产物，并且不留下任何决策记录。

## 影响

- `THIRD_PARTY_NOTICES.md` 新增一段披露，列出每个经审阅的 copyleft 运行时依赖及其义务。
- 任何再分发携带该 FFmpeg 可执行文件的构建物的人，都要承担那里列明的 GPL 义务。
- `isOwnerAuthorizedRuntime` 现在有两个来源——Claude Agent SDK 身份与该表——生成器对其他任何非宽松运行时依赖仍会立即失败。
