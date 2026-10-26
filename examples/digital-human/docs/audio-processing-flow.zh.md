# 原始音频控制与 Vidu 延迟展示流程

[返回总览](../README_ZH.md) · [设计动机与 PR 说明](pr-description.zh.md)

回执是客户端发给 Gateway 的播放状态消息；Gateway 的 `playback.clear` 是反方向的停止指令。
当前 Vidu 回执全部属于原始源音频时间线，不声明数字人已经出声或播完。

## 无数字人的普通本地 PCM 路径

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户
    participant C as 客户端
    participant G as Gateway
    participant M as Realtime 模型
    participant A as Agent 及工具
    participant P as 原始 PCM 播放器
    U->>C: 说话
    loop 麦克风开启，包括环境安静时的采样
        C->>G: input_audio_buffer.append
        G->>M: 经正常 Provider 转交用户音频
    end
    M-->>G: speech_started / stopped 及转写
    G-->>C: turn.started / voice.state / transcript
    opt 需要工具或后台任务
        M-->>G: 工具调用
        G->>A: 正常分派
        A-->>G: 结果或任务通知
        G->>M: 结果及后续播报
    end
    loop 回复流式音频
        M-->>G: 原始音频块
        G-->>C: audio.delta(responseId)
        C->>P: 连续调度真实 PCM，普通本地提前量 20 ms
    end
    P-->>C: 源音频时间线到达开始位置
    C->>G: playback.started(responseId)
    G->>G: speaking、播报占用、通知确认
    G-->>C: audio.done(responseId)，源已发送完
    C->>P: 输入结束，仍等待本地音源排空
    P-->>C: 本轮音源全部结束
    C->>G: playback.ended(responseId)
    G->>G: 正常收尾，处理后续播报
```

此处描述普通本地 PCM 的核心路径，不包括完整 WebUI 的远程抖动队列、显式静音消费路径、
设备切换等功能。当前示例两种对照模式使用同一份源播放器实现，并未改动内置 WebUI。

## Vidu：原始链路只静音，增加独立展示

```mermaid
sequenceDiagram
    autonumber
    participant C as 客户端
    participant G as Gateway
    participant M as 原有模型与 Agent 工具链
    participant P as 原始 PCM 播放器，gain=0
    participant B as 示例内 Vidu 适配器
    participant V as Vidu 与 ARTC
    participant R as 原生音视频元素
    par 原始对话连接
        C->>G: 标准 Gateway 会话
        C->>G: 麦克风或文字输入
        G->>M: 按正常配置处理输入
    and 展示初始化，无需阻塞 Gateway
        C->>B: session.open，角色图片
        B->>V: 创建 live、初始化控制连接
        B-->>C: 临时 RTC 凭证
        C->>V: ARTC 入会、订阅音视频
        V-->>R: 原始音轨与视频轨，同元素持续播放
    end
    loop 每个回复音频块
        M-->>G: 原始源音频
        G-->>C: audio.delta(responseId)
        C->>P: 立即调度真实 PCM，输出增益为零
        C->>B: 副本 audio.append，不等源播完
        B->>V: 原字节上传，不补静音
        V-->>R: 延迟返回音视频，按原生时序播放
    end
    P-->>C: 源音频时间线起播
    C->>G: playback.started(responseId)
    G-->>C: audio.done(responseId)
    C->>P: 源输入结束
    C->>B: audio.end，只封口输入
    P-->>C: 源音源排空
    C->>G: playback.ended(responseId)
    Note over V,R: 此时数字人可能仍在播放；不发送 interrupt、不摘轨、不静音
    Note over G,R: RTC 采样、起播、结束和故障都不产生或改变 Gateway 回执
```

原声对照开关仅将源 GainNode 从 0 改为 1，并静音/隐藏原生 RTC 元素；切回时反向交换。
它不修改任何音源、调度位置、回执或 Agent 配置。没有源音频可发送时，不向 Vidu 上传数据；
源 PCM 中已有的静音仍原样发送。厂商内部缓冲不可由客户端等同于等待空档推算。

## 打断：沿用原始判断，数字人不硬切

```mermaid
sequenceDiagram
    participant U as 用户
    participant C as 客户端
    participant G as Gateway
    participant M as Realtime 服务
    participant P as 源 PCM 播放器
    participant V as Vidu 展示
    alt 语音打断
        U->>C: 开口
        C->>G: 上传麦克风音频
        G->>M: 输入音频
        M-->>G: 服务端检测到语音，speech_started
        G-->>C: playback.clear、turn.started、listening
        G->>M: 取消原回复
        C->>P: 清理原始音源及队列
        C->>G: playback.cancelled(responseId)
    else 点击打断或提交新文字
        U->>C: 显式操作
        C->>P: 立即停止原始播放
        C->>G: playback.cancelled(responseId)
        C->>G: interrupt 或新文字输入
        G->>M: 正常取消旧回复及处理新输入
    end
    C->>V: 停止追加旧回复的后续源数据，仅本地输入隔离
    Note over C,V: 已上传媒体允许继续；不发送远端 interrupt、不等待媒体安静
```

模型打断判断来自原有 Realtime 服务，客户端不根据 Vidu 音频是否有声作判断。源播放器取消
与 Vidu 的连续输出是刻意分离的。带旧 responseId 的后续源块和旧源音源回调被隔离，但已经
上传的远端媒体不承诺隔离或立即停止。

## 回执会影响哪些原有行为

| 回执或指令 | 方向 | Gateway 行为 |
| --- | --- | --- |
| playback.started | 客户端 → Gateway | speaking、播报占用、条件满足时确认任务通知 |
| playback.ended | 客户端 → Gateway | 正常结束，处理工具后续播报与待播通知 |
| playback.cancelled | 客户端 → Gateway | 取消本轮呈现、清理待发转写；非用户取消的通知可能重试 |
| playback.clear | Gateway → 客户端 | 指令停止原始播放；Gateway 也同步清理自身播放状态 |
| interrupt | 客户端 → Gateway | 取消模型回复及原有回合处理，协议层映射 response.cancel |

因此所有上述回执仍由源音频管理，Vidu 不改变类型、原因或时机。展示错误只提示并回收展示，
不会取消源播放器。用户主动点击结束、新会话或重连属于原有显式会话操作，会清理两条连接。

## DHAV 仍保持真实媒体生命周期

```mermaid
flowchart LR
    G[Gateway 源 PCM] --> D[DHAV 服务]
    D --> P[成对 AV 帧与 MEDIA_END]
    P --> C[本地 PCM 与 canvas]
    C --> R[真实播放开始、排空、取消回执]
    R --> G
```

Vidu 不再使用此逐轮真实媒体交付契约。需要维护者认可这种延迟展示范围，不能将其回执描述
为 ARTC 实际播放证明。用户所听位置与模型上下文的差异也仍然存在，示例见 PR 说明。
