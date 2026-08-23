# Agent Note: Live-assist listens in the session it was started from

Status: implemented

[English](2026-08-23-live-assist-listens-in-the-current-session.md) | 中文

## Problem

开始面试助手会新建一个 dsh 会话并切换过去，因此面试内容从不落进当前打开的那个对话。这件事有两处出错。

从空白会话出发时，这个切换根本不会发生。`workspaces.startSession()` 复用工作区已有的空白会话，因此在空白会话里请求切换会拿回同一个 id；随后那套两步交接——在旧会话记录请求、由新会话中挂载的组件接手——就在等一个永远不会出现的接手方。面板无限期停在「正在连接…」，识别器从未启动；而且结束后选中的仍是一个空白会话，于是每次重试都落在同一个位置。

这个切换同时还在把面试写进会话列表看不见的会话里。`blank` 由「日志中没有 `turn/start`」推导而来（[api-proxy.ts](../../../../packages/host/apiproxy/src/api-proxy.ts)），而本插件追加的任何事件都不开启 turn，因此一个装着整场面试的会话仍然是 blank。客户端只在 blank 会话被选中时显示它，并把它标注为「New Session」（[tree.ts](../../../../packages/client/ui-workspace/src/client/tree.ts)），所以一切走就把面试从列表里抹去了——而且「新建会话」会复用 blank 会话，于是下一场面试被追加进同一份日志。几分钟的使用就产出了三个这样的会话，分别装着 6、96、296 条事件，各自带着已生成的标题。

## Decision

监听就在输入框所在的那个会话里进行。不创建任何东西，也不切换到任何地方。

`LiveAssistController.start(background, session, share)` 直接对这个会话打开 socket，取代了 `request`／`adopt` 交接以及它所需要的 `awaiting` 状态。输入框 slot 是 session 作用域的，因此点击那一刻手里必然有一个会话，控制器也就不再需要 `workspaces` 与 `sessions` 这两个服务。

控制器仍然在 React 之外持有采集与 socket，因为用户可能在识别器运行期间切换会话，而那会重新挂载每个 session 作用域组件。转写与回答始终落在 `start` 消息里指明的那个会话，而不是当前显示在屏幕上的会话。

想让面试单独占一个会话依然可行——用户先新建会话，再开始。这是一次刻意的动作，取代了每次开始都触发的切换。

blank 本身不在这里修，因此设置对话框把它讲明：当挂载所在的会话是空白会话时，它说明这场面试不会清除那个 bit、该会话因此会离开列表并被复用、先发一条消息就能留住它。在用户唯一能采取行动的那一刻给出提醒，代价是一个注入的判定函数；不这么做的代价，是一个用户事后找不到、也不知道为什么找不到的会话。

## Alternatives considered

**仍然新建会话，只在当前会话非空白时才建。** 这是死锁刚被修复后已发布的行为。它解决了卡死，却恰恰在走就地路径的那种情形下继续把面试写进空白会话——于是用户最想留下的材料，正是被列表隐藏、又会被下一次「新建会话」覆盖的材料。

**继续新建会话，并让插件自己的事件清除 `blank`。** 这才是让「面试独占一个会话」真正可行的修法；如果面试就该与对话分开，它仍然是对的方案。之所以不在本次范围内：它改变了 `blank` 对所有消费者的含义——`SessionEventMap` 的成员需要声明自己属于会话内容，生成器需要产出这个集合，`api-proxy` 需要在已附着与冷探测两条路径上都折叠它。

**由插件写一条 `turn/start`，让会话不再是 blank。** 它不需要任何新词汇。之所以否决：一个 turn 是一次 model-loop 执行，而 `dsh-session` 自己的不变量会校验 turn 序列；合成的 turn 是一句会被会话日志当场验伪的谎话。

## Consequences

- 换来：一次总能完成的启动；以及一场落在列表会显示、并带着已生成标题的会话里的面试。
- 代价：面试并入当时打开的那个对话。想要分开的用户先新建会话即可。
- 面板的输入框控件是 session 作用域的，因此不存在「无会话视图」下的启动路径。这本来就是该控件已经渲染的那个界面。
- 在空白会话里开始的面试，仍然产出一个空白会话，因为这里没有任何东西会清除那个 bit。要确保列表保留它，先新建会话并在其中发送任意内容，再开始。

## Testing

`tests/live-controller.client.spec.ts` 把控制器从 `start` 驱动到一条活的 socket，并断言 `start` 消息指明的正是传入的那个会话。运行期间的第二次 `start` 被拒绝，且不触碰正在运行的 socket，也不动调用方的流。

`tests/panel.client.spec.tsx` 断言点击路径以挂载所在的会话调用 `start` 且不打开任何其他会话，断言在另一个 session id 下重新挂载既不会重启也不会丢掉正在运行的识别器，并断言空白会话提示只在注入的判定函数报告为空白时出现。

## Related

- [Live counterpart-only meeting assist](2026-08-22-live-counterpart-only-meeting-assist.md) —— 本 bundle，其启动会创建并切换到一个会话。
- [Named before listening](2026-08-23-live-assist-named-before-listening.md) —— 一次启动在识别器打开之前所做的另一半事情。
