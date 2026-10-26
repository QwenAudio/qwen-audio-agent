# Vidu 延迟展示方案验证

本记录对应 2026-10-26 的当前未提交工作区，非历史对齐方案。未在本轮调用付费模型或 Vidu，
也未声称完成真实服务验收。测试使用 Node v26.6.0、已安装 Chrome 和固定 SDK 接口的假服务。

## 已通过

- 示例单元与本地 WebSocket 回归：119 项全部通过。
- Vidu 浏览器回归：源 PCM 经实际浏览器 Web Audio 调度，增益为 0 且数据非空非零；
  无关远端音频不影响 started/ended；按钮打断只取消源播放器，RTC 同一音视频轨持续且未静音/摘轨。
- 原声对照：同一源播放器 gain=1，RTC 静音并隐藏，切回 gain=0；不重建源数据或改变回执。
- Vidu 故障后原始会话仍 connected，后续源回复正常 ended；重连释放旧 RTC 资源。
- 服务端收到的跨回复 PCM 保持原字节与顺序，不补静音；无逐轮 type 7 interrupt。
- DHAV 浏览器回归：正常完成、打断、迟到帧、麦克风、重连、媒体超时和断流通过。
- 客户端生产构建通过；修改的 JS/MJS 使用 `eslint --no-ignore` 检查通过。

Node 测试还比对静音与原声模式的 PCM 样本、源调度位置和 Gateway 回执完全一致，
并验证 Vidu 永不就绪、异步旧轨返回、RTC 自动播放失败和未完成入会清理。

## 命令

```sh
npm test
npm run build:client
DH_BROWSER_CHANNEL=chrome npm run test:browser:vidu
DH_BROWSER_CHANNEL=chrome npm run test:browser
```

这些结果证明本例的源时间线与展示解耦，不证明物理扬声器出声、真实 Vidu 延迟、长时间连续
人物动作、实际弱网和音画同步。未执行真实服务端到端复测，也未验证所有 Provider 或远程 WebUI
的行为一致性。原审核范围变化仍需维护者确认，不能将测试通过表述为审核条件全部满足。
