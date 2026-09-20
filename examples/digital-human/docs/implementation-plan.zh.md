# OpenAvatarChat 数字人 Demo 开发与验收计划

状态：设计交接，待确认后实施。本轮不含代码、依赖安装、模型下载、测试执行或推送。

前置阅读：[架构](design.zh.md)、[Provider 契约](provider-contract.zh.md)。原有英文方案和 ADR 均为历史草案。

## 1. 交付结果

开发者交付一个只连接网关的 WebUI。用户说话后，现有 Realtime 生成回复，独立 OpenAvatarChat Renderer 产生说话头像，经网关 WebRTC 播放。

- 默认演示 Audio 模型，不依赖摄像头或 Omni 才能显示数字人。
- 使用一个经过授权的头像资产，展示 idle、listening、rendering、speaking、audio-only、error 状态。
- 可查看文本、打断、断开重连、恢复原 session，并看到明确的降级状态。
- WebUI 从网关同源路由提供，延续已有认证；不能直接 fetch Renderer 或加入厂商房间。
- 麦克风仅在连接和音频播放准备就绪后开启，失败时有用户手动恢复入口。
- 关闭数字人后保持原有 WSS/WebRTC 音频体验。

## 2. 建议代码组织

下面是未来文件布局，不表示这些文件已经存在。

```text
examples/digital-human/
  README.md
  README_ZH.md
  docs/
  package.json
  package-lock.json
  .env.example
  .gitignore
  bootstrap/
    start.mjs
    preflight.mjs
  client/
    index.html
    client.mjs
    styles.css
  providers/
    mock/
    openavatarchat/
  media/
    framed-av-source.mjs
  renderer/
    pyproject.toml
    uv.lock
    upstream.lock.json
    service/
    adapters/openavatarchat/
    tests/
  fixtures/
  test/
  deploy/
    Dockerfile
    compose.yaml
```

`node_modules`、`.venv`、`.env.local`、模型、上游 checkout、缓存、测试录像和生成媒体均在 example 内独立管理并忽略提交。不要提交真实密钥、个人音频或未获许可的肖像。

主框架的未来开发项只包含 SPI/编排及媒体扩展，具体落点由 M0 确认，建议新增独立的 `presentation/digital-human` 模块，避免继续扩张 `voice/realtime-session-runtime.mjs`。本轮不创建这些代码目录。

## 3. 依赖清单与锁定

| 环境 | 计划使用 | 隔离要求 |
| --- | --- | --- |
| Mac 网关/example | 与框架 engines 相容的 Node，example 自有依赖锁 | 不加入根 workspaces |
| WebRTC 媒体 | 已有 `qwen-audio-agent-webrtc` 扩展 | 显式安装到 example 可解析的位置；不得依赖用户全局安装碰巧存在 |
| Node 私有协议 | `ws`，使用框架允许的版本范围并在 example 锁定 | 不修改主框架依赖表 |
| GPU 服务 | Python 3.11 系列、`aiohttp`、NumPy、PyTorch 及实际需要的上游推理依赖 | 以选定上游 revision 为准，独立 venv/镜像 |
| 媒体转换 | 上游环境中的 OpenCV 等必要组件 | 只保留一种 OpenCV 安装，避免 headless 与非 headless 冲突 |
| 测试 | Node 内置测试、Playwright、pytest | example 开发依赖，不默认进入框架安装 |

[上游 pyproject](https://github.com/HumanAIGC-Engineering/OpenAvatarChat/blob/main/pyproject.toml) 的依赖比单个 Avatar 组件宽。不能直接把它的全部要求合并进框架；也不能凭想象列一个“最小依赖”便宣称可运行。

M0 必须记录：OpenAvatarChat commit、SoulX-FlashHead 子模块 commit、各权重 revision/校验值、Python/torch/CUDA 组合、Node 扩展版本和目标 GPU。记录到 example 的 `upstream.lock.json` 与各自锁文件；禁止启动时追踪最新 main 或自动升级。

首先复现上游支持的 GPU 环境，再依据实际 import/运行路径裁剪 example 的依赖。模型初始化、头像预处理等上游必要行为应保留，不能为了减小依赖而复制推理代码。源码许可证不代表权重和头像资产自动允许同样使用，分别审计。

源代码开发时，example 可使用到 `packages/webrtc` 的显式本地依赖；发布模式仅在扩展实际发布后使用已验证的 npm 版本。未来媒体子进程需要显式的可信扩展解析入口，否则当前从主框架目录解析依赖的方式可能找不到 example 私有安装。

## 4. OpenAvatarChat 具体实现

### 4.1 复用范围

复用 [FlashHeadProcessor](https://github.com/HumanAIGC-Engineering/OpenAvatarChat/blob/main/src/handlers/avatar/flashhead/flashhead_processor.py) 及上游模型初始化/预处理路径，参考 [Handler](https://github.com/HumanAIGC-Engineering/OpenAvatarChat/blob/main/src/handlers/avatar/flashhead/avatar_handler_flashhead.py) 接线。不启动 OpenAvatarChat WebUI、RTC 服务、ASR、LLM、TTS 或完整 ChatEngine 对话链路。

Renderer 负责薄封装：会话、音频格式适配、任务队列、生命周期映射、媒体打包和资源隔离。主框架不 import Python，不了解 FlashHead tensor、checkpoint 路径或窗口参数。

若上游初始化强依赖 ChatEngine，先列出最小兼容包装；不能悄悄启动整套对话服务。确需上游修改时优先贡献补丁，无法及时合入则使用固定 revision 的最小 fork，记录 patch 及回归测试。

### 4.2 音频输入与流式推理

输入使用 PCM16/24 kHz/mono；Python 转为 float 数组，保留原始播放音频，另行有状态重采样为 FlashHead 推理采样率。根据源样本数维护整数累计计数，不靠每块时长浮点相加。

持续喂入 Processor，不等待整句或完整 WAV。结束时 flush 重采样器和模型窗口，区分输入尾部与模型 padding。上游窗口长度来自固定模型配置，不能为了追求低延迟随意改小。

Processor 调用属于推理工作线程/进程，不应阻塞 HTTP/WSS 事件循环。取消控制必须有独立调度机会，慢推理不能让心跳和断开清理失效。

### 4.3 上游包装必须处理的边界

这些是根据当前源码识别的适配任务，不代表上游已经实现了我们的契约：

- Handler 中的分块重采样不能被直接当成跨 chunk 连续重采样保证，适配器应建立有状态转换与样本覆盖测试。
- Processor 的视频/音频回调不是完整的带 TurnRef/PTS 公共协议，需要捕获配对关系、补齐元数据并测试尾部静音。
- 当前输出队列并非我们定义的有界队列；在输入准入和输出积压处施加限制，不能仅限制网络队列而任由内部推理积压。
- 单纯 interrupt 后立刻 reset 不能证明在途 GPU 作业已经停止；禁止旧作业产物被标记为新代次。
- 首版采用一个 GPU worker 同时一个活跃 avatar session，不依赖不同 Processor 的私有锁来证明共享模型的并发安全。
- 如无法从回调可靠关联 speech/generation，应等待旧任务退出并替换 Processor/worker，或补上游 hook；不得根据“当前 session ID”给所有回调重新贴标签。

这些任务只围绕上游组件的边界，不能演变成在 example 重写 FlashHead。

## 5. 私有 Renderer 协议

此协议仅属于 OpenAvatarChat example，不要求 LiveAvatar 或框架所有 Provider 实现同一组远程端点。

### 5.1 会话与通道

| 拟议端点 | 用途 |
| --- | --- |
| `GET /health/live` | 服务进程存活，不等于模型就绪 |
| `GET /health/ready` | 模型/资源可接收会话，未就绪返回明确状态 |
| `POST /v1/avatar/sessions` | 授权后创建白名单 persona，返回临时 session 和两个通道的受限凭证 |
| `WSS /v1/avatar/sessions/{id}/input` | 控制及二进制输入音频，由网关适配器连接 |
| `WSS /v1/avatar/sessions/{id}/media` | 配对媒体，由 Media Worker 连接 |
| `DELETE /v1/avatar/sessions/{id}` | 幂等关闭，触发资源释放 |

本机 Mock 可用 loopback HTTP/WS；跨主机使用 TLS 和短期凭证。input 凭证不能任意订阅其他媒体，media 凭证不能创建会话。Renderer 地址由服务端配置白名单提供，防止 SSRF。

两个通道都准备好后才发 session.ready。媒体订阅断开时不能无限渲染到无消费者队列。进程关闭、心跳丢失或凭证撤销时释放会话；不要等永久挂起的 GPU 调用。

### 5.2 消息格式

控制帧使用 JSON，含协议版本、requestId、TurnRef、操作和必要格式。操作为 start/finish/cancel/close，与 SPI 一一对应。输入结束携带最后序号和真实输入样本数。

音频/媒体使用单个 WebSocket 二进制消息封装一条记录，不把视频 Base64 放进 JSON：

```text
16-byte prefix:
  magic[4] = DHAV
  version u8 = 1
  kind u8 = 1 (input PCM) | 2 (paired AV) | 3 (media end)
  flags u16 = 0
  headerLength u32
  payloadLength u32
UTF-8 JSON header
binary payload
```

整数使用网络字节序。header 包含 TurnRef、sequence、sampleOffset/有效样本数、ptsUs/durationUs、格式及各负载段长度。配对媒体 payload 顺序为 PCM 音频、I420 视频；长度必须与通道数和图像尺寸一致。拒绝未知版本、溢出、负长度、畸形数据和缺失序号。

初始防护上限：JSON header 4 KiB、单条二进制记录 1 MiB、控制帧 16 KiB、视频不超过协商的 512x512。缩放和像素转换由 example 的 Renderer 媒体层完成；模型实际尺寸/兼容性在 M0 固定。结束记录只有元数据，无媒体正文。

generation/sequence 必须同时在 Renderer 输入、私有媒体解码和最终发布处检查。跨通道不能假定消息到达顺序，取消后的旧媒体即使先于 ACK 到达也必须被隔离。

### 5.3 性能范围与背压

512x512 I420、25 FPS 的原始视频约为 9.4 MiB/s，尚未计协议开销。此方案用于同机或高带宽内网，不是公网部署承诺。GPU 在远端时应优先将网关媒体层部署在同一内网，Mac 浏览器只接收压缩后的 WebRTC。

禁止让这些 raw 帧经过网关主进程的 JSON IPC；媒体适配器在 child 内直接连接 Renderer。若需要跨低带宽链路，另行评审编码媒体或内部 WebRTC，不在首版偷偷增加完整 SFU。

首版建议按媒体时长和字节同时限流：总待消费回复音频最多 10 秒、首帧 fallback 缓冲最多 10 秒、媒体发布队列约 120 ms，并为模型完整输出窗口保留单独有界空间。模型可能一次产生一组帧，不能因为网络队列小就丢弃任意中间 PCM。具体字节额度由分辨率与音频格式计算。

超限时先停止继续准入；若无法在期限内恢复，进入明确的 overload/降级/取消策略。普通音频出口仍遵守已有容量限制。队列上限不是目标延迟，不能以“没达到上限”为理由长期积压。

## 6. 媒体与播放验证先于 GPU 集成

先用 Mock 生成带帧号、响应 ID、颜色变化和已知音频脉冲的配对媒体，走与真实 Renderer 相同的私有协议和网关视频轨道。不能用客户端 CSS 动画替代此测试。

Media Worker 将原音频转为现有输出格式，按统一单调时钟调度视频与音频，采用同一个媒体同步组。具体 native API 的时间戳、流标识、暂停与清队列行为必须实验确认，不能仅因它支持视频就假设同步已解决。

客户端播放检测可以组合 video frame callback、音频播放状态及统计信息，但应标注精度和不可观测区间。现有近似回执、临时静音策略不自动视为通过数字人验收。若没有可验证的响应边界，不把服务端发送排空伪装为客户端播放结束。

最保守的中断恢复可以重建媒体连接，但必须测量代价并保留 owner/session 的正确恢复；不宣称重建连接等同于无缝打断。

## 7. 里程碑和工作拆分

| 阶段 | 工作 | 完成门槛 |
| --- | --- | --- |
| M0：接口与环境冻结 | 确认本文，固定上游版本，审计依赖，验证媒体库能力和初始化包装 | 有记录的版本清单、可复现实验、无待猜测的关键媒体 API |
| M1a：框架接入点 | 呈现 SPI、输出选择器、取消、启动注入、能力协商及媒体 Adapter 注册 | 禁用时零行为变化，协议/生命周期单测通过 |
| M1b：Mac Mock | 独立 Mock、实际视频下行、WebUI、失败注入 | 真实音视频轨道、打断/降级/重连可验收，不依赖 CUDA |
| M2：GPU 实接 | Python Renderer、OpenAvatarChat 复用、音频转换、隔离、部署和预热 | 不改客户端即可换成真实头像，完成指定 GPU 上的质量/性能验证 |
| M3：交接与稳定性 | 安装/开发/部署说明、故障手册、测试矩阵和依赖打包检查 | 同事按文档从干净环境复现，默认框架安装不拉取 example 依赖 |

LiveAvatar 的付费实接、三个人设热切换、多 GPU 调度、完整公网媒体平台不属于首版。可用模拟事件证明契约映射，但不能声称已测通 LiveAvatar。

建议按职责拆 PR：框架中立扩展、Mock/WebUI、OpenAvatarChat Renderer、交付验收。每个 PR 只携带其所需改动；根 README 不动。

## 8. 测试和验收矩阵

| 层 | 必须覆盖 |
| --- | --- |
| Provider 契约 | start/append/finish/cancel/close、幂等、空音频、序号缺口、晚到回调、格式错误 |
| 输出选择器 | 首包与 fallback 竞争、首包后失败不重播、取消不降级播放被拒绝音频 |
| 呈现语义 | 文本播放门控不阻塞渲染、任务播报原因保真、Provider 完成不冒充客户端回执 |
| 音频 | 不同 chunk 切分结果连续、重采样尾部、样本覆盖、padding 和静音不重复播放 |
| 认证/隔离 | 伪造 owner、跨 owner session、越权 persona、Renderer SSRF、私有 token 泄漏、撤权和接管 |
| Mock 浏览器 | 实际远端视频轨道、Audio 无摄像头也可用、静音、打断、自动播放受限、重连/历史 |
| 故障注入 | 首帧超时、推理卡住、两条私有通道断开、子进程崩溃、过载、客户端慢消费 |
| WSS 回归 | 未启用数字人时原消息、音频、内容安全恢复、会话恢复和桌面行为不变 |
| WebRTC 回归 | 普通 Audio、Omni 摄像头、SDP、会话接管、原有 extension 发现和关闭流程 |
| GPU | 真实头像音画质量、持续速度、冷/热启动、打断后旧嘴型、资源清理和稳定运行 |
| 依赖/打包 | 根默认安装和主 npm 包不含 example SDK/native/模型，私有环境和测试媒体不入包 |

自动化默认只用合成媒体/模拟 Realtime，禁止偷偷使用真实用户历史或付费 API。真实模型和 GPU 验收需显式配置、授权及独立运行。

不以共享历史条数为本功能修改点。至少测试相同 owner 的两个 session 恢复和断线后新 avatarSessionId，确认不重放旧媒体。

## 9. 初始测量目标

目标不是已达到的承诺，首个版本必须报告实测结果：

- 稳态目标 25 FPS，热态数字人首播增量延迟 p95 不超过 1.5 秒。
- 稳态绝对音画偏差目标不超过 80 ms。
- 用户打断到本地停止呈现目标 p95 不超过 250 ms；另行记录最后一段残留音视频的实际时长。
- 20 轮连续回复及多次打断/重连无旧帧串入；至少一次 30 分钟持续运行检查队列和资源趋势。
- 模型冷启动单独记录，不把模型下载/加载藏进“首帧”指标，也不与热态目标混算。

建议默认首媒体期限为 3 秒，模型预热使用独立可配置期限。若输入积压先达到上限，提前按 commit 边界处理，不能等期限到了才发现内存失控。

每次报告记录固定 commit/权重、GPU/驱动/CUDA、分辨率/FPS、窗口、并发和网络条件。跨进程时钟未校准时只报告同一时钟测量的 span，不直接相减两个机器的 monotonic 时间。

未达标时明确区分推理窗口、模型速度、媒体桥接和网络耗时；不能只给模型 FPS 作为实时体验证明。

## 10. 启动与交接要求

未来需要提供三类有清晰帮助信息的入口：Mac Mock、GPU Renderer、连接指定 Renderer 的 example Gateway。脚本名待实现，不在当前 README 放置不可执行的 npm 命令。

preflight 必须检查框架扩展 API 版本、example 私有 WebRTC 扩展可发现性、端口占用、服务认证、上游模型配置和 Renderer readiness。不能 kill 既有网关、覆盖桌面配置或修改用户全局 npm 环境。

开发说明同时覆盖源代码模式和未来已发布包模式。框架组合 API 或扩展尚未发布时，正式模式标记未发布，不能指导用户安装不存在的包版本。

交接清单：

- 三份设计文档的评审结论和偏离项记录。
- Node/Python/upstream 锁文件及许可证/头像授权说明。
- Mac Mock、GPU 部署、启动/停止/清理与故障排查说明。
- 可重复的测试命令、合成 fixtures、实测报告与已知限制。
- 清楚列出新增框架扩展点，证明厂商依赖全部留在 example。
- 全部检查通过且用户确认后再推送；本设计任务本身不授权后续自动实现或发布。

## 11. 参考来源与实现前复核

以下链接在设计时用于核对接口，不是版本锁；实施前用 M0 确定的 commit 替换上游源码引用，并复核云 API：

- [OpenAvatarChat FlashHead Handler](https://github.com/HumanAIGC-Engineering/OpenAvatarChat/blob/main/src/handlers/avatar/flashhead/avatar_handler_flashhead.py)
- [OpenAvatarChat FlashHead Processor](https://github.com/HumanAIGC-Engineering/OpenAvatarChat/blob/main/src/handlers/avatar/flashhead/flashhead_processor.py)
- [FlashHead 配置](https://github.com/HumanAIGC-Engineering/OpenAvatarChat/blob/main/src/handlers/avatar/flashhead/flashhead_config.py)
- [OpenAvatarChat Python 依赖](https://github.com/HumanAIGC-Engineering/OpenAvatarChat/blob/main/pyproject.toml)
- [LiveAvatar Avatar Only](https://docs.liveavatar.com/docs/lite-mode/overview)
- [LiveAvatar LITE 事件](https://docs.liveavatar.com/docs/lite-mode/events)
- [LiveAvatar 媒体接入路径](https://docs.liveavatar.com/docs/lite-mode/integration-paths)
