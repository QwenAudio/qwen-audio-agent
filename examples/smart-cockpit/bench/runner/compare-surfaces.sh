#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Frontend/backend tool execution speed comparison — one-shot runner.
#
# Usage:
#   bash examples/smart-cockpit/bench/runner/compare-surfaces.sh
#   bash examples/smart-cockpit/bench/runner/compare-surfaces.sh --domain vehicle
#   bash examples/smart-cockpit/bench/runner/compare-surfaces.sh --repeats 5
#
# Output:
#   examples/smart-cockpit/bench/reports/surface-compare-latest.json
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
cd "$ROOT_DIR"

# Load the smart-cockpit environment variables (.env and friends).
if [ -f examples/smart-cockpit/.env ]; then
  set -a
  source examples/smart-cockpit/.env
  set +a
fi

echo "═══════════════════════════════════════════════════════════"
echo "  Smart Cockpit — frontend/backend tool execution speed"
echo "═══════════════════════════════════════════════════════════"
echo ""

# ── Phase 1: in-process execution baseline (no API key needed) ──
echo "▶ Phase 1: direct tool execution latency (direct)"
echo "  measures pure CockpitService.execute() time per tool"
echo ""

node examples/smart-cockpit/bench/runner/run-surface-compare.mjs \
  --mode direct \
  --repeats 5 \
  --out examples/smart-cockpit/bench/reports/surface-compare-direct-latest.json \
  "$@"

echo ""

# ── Phase 2: real route comparison (no API key needed) ──
echo "▶ Phase 2: real route latency (transport)"
echo "  one tool over frontend MCP/HTTP vs backend A2A->Agent->MCP, stub model"
echo ""

node examples/smart-cockpit/bench/runner/run-surface-compare.mjs \
  --mode transport \
  --repeats 5 \
  --out examples/smart-cockpit/bench/reports/surface-compare-transport-latest.json \
  "$@"

echo ""

# ── Phase 3: model inference hop comparison (needs DASHSCOPE_API_KEY) ──
if [ -n "${DASHSCOPE_API_KEY:-}" ]; then
  echo "▶ Phase 3: model inference hop comparison (model)"
  echo "  ${DASHSCOPE_MODEL:-qwen3.8-flash}: frontend 1 hop vs backend 2 hops (delegate + Agent)"
  echo ""

  node examples/smart-cockpit/bench/runner/run-surface-compare.mjs \
    --mode model \
    --out examples/smart-cockpit/bench/reports/surface-compare-model-latest.json \
    "$@"
else
  echo "⚠ skipping Phase 3 (model mode): DASHSCOPE_API_KEY is not set"
  echo "  to measure model inference latency, set it and run again:"
  echo "    export DASHSCOPE_API_KEY=your-key"
  echo "    bash examples/smart-cockpit/bench/runner/compare-surfaces.sh"
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  done"
echo "═══════════════════════════════════════════════════════════"
