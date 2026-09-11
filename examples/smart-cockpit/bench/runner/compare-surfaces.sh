#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# 前后端工具执行速度对比评测 —— 一键运行脚本
#
# 用法：
#   bash examples/smart-cockpit/bench/runner/compare-surfaces.sh
#   bash examples/smart-cockpit/bench/runner/compare-surfaces.sh --domain vehicle
#   bash examples/smart-cockpit/bench/runner/compare-surfaces.sh --repeats 5
#
# 输出：
#   examples/smart-cockpit/bench/reports/surface-compare-latest.json
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
cd "$ROOT_DIR"

# 加载 smart-cockpit 环境变量（.env 等）
if [ -f examples/smart-cockpit/.env ]; then
  set -a
  source examples/smart-cockpit/.env
  set +a
fi

echo "═══════════════════════════════════════════════════════════"
echo "  Smart Cockpit — 前后端工具执行速度对比评测"
echo "═══════════════════════════════════════════════════════════"
echo ""

# ── Phase 1: 进程内执行基线（不需要 API Key） ──
echo "▶ Phase 1: 工具直接执行延迟 (direct)"
echo "  测量 CockpitService.execute() 对每个工具的纯执行耗时"
echo ""

node examples/smart-cockpit/bench/runner/run-surface-compare.mjs \
  --mode direct \
  --repeats 5 \
  --out examples/smart-cockpit/bench/reports/surface-compare-direct-latest.json \
  "$@"

echo ""

# ── Phase 2: 真实链路对比（不需要 API Key） ──
echo "▶ Phase 2: 真实链路延迟 (transport)"
echo "  同一工具分别走 前台 MCP/HTTP 与 后台 A2A->Agent->MCP，模型为零耗时 stub"
echo ""

node examples/smart-cockpit/bench/runner/run-surface-compare.mjs \
  --mode transport \
  --repeats 5 \
  --out examples/smart-cockpit/bench/reports/surface-compare-transport-latest.json \
  "$@"

echo ""

# ── Phase 3: 模型推理跳数对比（需要 DASHSCOPE_API_KEY） ──
if [ -n "${DASHSCOPE_API_KEY:-}" ]; then
  echo "▶ Phase 3: 模型推理跳数对比 (model)"
  echo "  ${DASHSCOPE_MODEL:-qwen3.8-flash}: 前台 1 跳 vs 后台 2 跳（委派 + Agent 选工具）"
  echo ""

  node examples/smart-cockpit/bench/runner/run-surface-compare.mjs \
    --mode model \
    --out examples/smart-cockpit/bench/reports/surface-compare-model-latest.json \
    "$@"
else
  echo "⚠ 跳过 Phase 3 (model 模式): 未设置 DASHSCOPE_API_KEY"
  echo "  如需测试模型推理延迟，请设置环境变量后重新运行："
  echo "    export DASHSCOPE_API_KEY=your-key"
  echo "    bash examples/smart-cockpit/bench/runner/compare-surfaces.sh"
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  评测完成"
echo "═══════════════════════════════════════════════════════════"
