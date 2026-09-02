// 会话内短期压缩的阈值配置。
//
// 全部数值来自评测框架 compression_test/core/config.py 的实测口径，
// 迁移时已在远端逐项验证（window 8000 → clear 4800 / compact 6400 / target 4000
// / summaryMax 2000 / keepLastMessages 8）。改动任何一项前请先读注释里的依据。

// 清嗓线：到此水位先做零成本的规则剪枝（不调模型）。
const CLEAR_RATIO = 0.6

// 压缩线：到此水位才走摘要。
const COMPACT_RATIO = 0.8

// 压缩后的目标水位。
//
// 为什么是 0.5 而不是更低：每次喂给摘要器的批量 B ≈ compactAt - target
// = window × (compactRatio - targetRatio)。实测摘要器的输出量稳定为输入量的
// 26%~32%（固定压缩比 r，与上限无关），滚动摘要的稳态长度 = r×B/(1-r)：
//   target 0.5 → B=4800 → 稳态约 1400 token（与实测 802~1470 吻合）
//   target 0.3 → B=8000 → 稳态约 2300 token
// 即：想让摘要写得更全，唯一有效的杠杆是加大 B，而不是改 prompt 措辞
// （"让摘要写更长"这个方向已被三次独立实验否证）。
// 代价：target 越低，窗口里留的原文越少。
const TARGET_RATIO = 0.5

// 摘要自身的长度上限（占窗口比例）。
// 必须有：否则在"纯事实流"场景会出现滚动摘要无界膨胀 → 水位降不下去
// → 每来一条消息就触发一次压缩的死循环（已复现）。
// 0.25 在 window 8000 下 = 2000 token。
const SUMMARY_MAX_RATIO = 0.25

// 最近 N 条消息永不压缩（4 轮问答 = 8 条）。
const KEEP_LAST_MESSAGES = 8

export function createCompactionConfig({
  windowTokens = 8000,
  clearRatio = CLEAR_RATIO,
  compactRatio = COMPACT_RATIO,
  targetRatio = TARGET_RATIO,
  summaryMaxRatio = SUMMARY_MAX_RATIO,
  keepLastMessages = KEEP_LAST_MESSAGES,
} = {}) {
  const window = Math.max(1, Number(windowTokens) || 8000)
  return {
    windowTokens: window,
    clearRatio,
    compactRatio,
    targetRatio,
    summaryMaxRatio,
    keepLastMessages: Math.max(0, Number(keepLastMessages) || 0),
    clearAt: Math.trunc(window * clearRatio),
    compactAt: Math.trunc(window * compactRatio),
    target: Math.trunc(window * targetRatio),
    summaryMax: Math.trunc(window * summaryMaxRatio),
  }
}

export const COMPACTION_DEFAULTS = {
  CLEAR_RATIO,
  COMPACT_RATIO,
  TARGET_RATIO,
  SUMMARY_MAX_RATIO,
  KEEP_LAST_MESSAGES,
}
