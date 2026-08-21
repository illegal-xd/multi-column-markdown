#!/usr/bin/env bash
# ============================================================================
# publish-marketplace.sh — 一键发布到 VS Code Marketplace
#
# 用法:
#   ./scripts/publish-marketplace.sh -p <publisher> [-t <pat>]
#
#   -p <publisher>  Marketplace 注册的 Publisher Name（必填）
#   -t <pat>        Azure DevOps PAT（可选；也可用环境变量 VSCE_PAT，
#                   或预先执行 npx vsce login <publisher>）
#
# 行为:
#   1. 若 package.json 的 publisher 为占位值 "local"，临时写入真实
#      publisher，发布后恢复（不污染工作区）
#   2. npm run build + vsce publish 发布
#   3. 输出市场链接
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

PUBLISHER=""
PAT="${VSCE_PAT:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p) PUBLISHER="$2"; shift 2 ;;
    -t) PAT="$2"; shift 2 ;;
    *) echo "!! 未知参数: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$PUBLISHER" ]]; then
  echo "!! 缺少 -p <publisher>（在 https://marketplace.visualstudio.com/manage 注册的 Publisher Name）" >&2
  exit 1
fi

VERSION="$(node -p "require('./package.json').version")"
CURRENT_PUBLISHER="$(node -p "require('./package.json').publisher")"
RESTORE_PUBLISHER=false

# ── publisher 字段处理 ─────────────────────────────────────
if [[ "$CURRENT_PUBLISHER" == "local" ]]; then
  echo ">> 临时写入 publisher: ${PUBLISHER}（发布后恢复）"
  node -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    p.publisher = '${PUBLISHER}';
    fs.writeFileSync('package.json', JSON.stringify(p, null, 2));
  "
  RESTORE_PUBLISHER=true
elif [[ "$CURRENT_PUBLISHER" != "$PUBLISHER" ]]; then
  echo "!! package.json publisher (${CURRENT_PUBLISHER}) 与参数 (${PUBLISHER}) 不一致" >&2
  exit 1
fi

restore_publisher() {
  if [[ "$RESTORE_PUBLISHER" == "true" ]]; then
    node -e "
      const fs = require('fs');
      const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
      p.publisher = 'local';
      fs.writeFileSync('package.json', JSON.stringify(p, null, 2));
    "
    echo ">> 已恢复 publisher 字段"
  fi
}
trap restore_publisher EXIT

# ── 构建与发布 ──────────────────────────────────────────────
echo ">> 构建扩展（v${VERSION}）…"
npm run build

echo ">> 发布到 VS Code Marketplace（publisher: ${PUBLISHER}）…"
if [[ -n "$PAT" ]]; then
  ./node_modules/.bin/vsce publish -p "$PAT"
else
  ./node_modules/.bin/vsce publish
fi

echo ""
echo "✔ 已发布 v${VERSION}"
echo "  市场链接: https://marketplace.visualstudio.com/items?itemName=${PUBLISHER}.multi-column-markdown"
