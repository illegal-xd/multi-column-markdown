#!/usr/bin/env bash
# ============================================================================
# release.sh — 按当前版本自动创建 GitHub Release，release notes 由 commit
# 内容生成（上次 tag → HEAD），并上传 vsix 产物
#
# 用法:
#   ./scripts/release.sh                # 常规发布（先运行 publish-packages.sh 可选）
#   ./scripts/release.sh --dry-run      # 只打印将要执行的内容，不真正发布
#
# 前置:
#   - gh CLI 已安装并认证（gh auth login）
#   - 当前分支已 push（脚本基于 origin 的 tag 计算 notes）
#
# 行为:
#   1. 读取 package.json 版本号 VERSION
#   2. 查找最近 tag（git describe），生成 commit notes：
#      - 按 Conventional Commits 分组（feat/fix/docs/refactor/…）
#      - 无最近 tag 时从仓库起始生成
#   3. 创建/更新 tag v$VERSION 并 push
#   4. gh release create v$VERSION，上传 multi-column-markdown-$VERSION.vsix
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

# ── 版本 ────────────────────────────────────────────────────
VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"
echo ">> 版本: ${TAG}"

# 构建 vsix（Release 资产）
echo ">> 构建并打包 vsix…"
npm run build >/dev/null
./node_modules/.bin/vsce package --no-dependencies >/dev/null
VSIX_FILE="multi-column-markdown-${VERSION}.vsix"
[[ -f "$VSIX_FILE" ]] || { echo "!! vsix 未生成" >&2; exit 1; }

# ── 生成 Release Notes（由 commit 内容渲染）───────────────
LAST_TAG="$(git describe --tags --abbrev=0 2>/dev/null || true)"

if [[ -n "$LAST_TAG" && "$LAST_TAG" != "$TAG" ]]; then
  RANGE="${LAST_TAG}..HEAD"
  HEADER="## What's Changed (since ${LAST_TAG})"
else
  RANGE=""
  HEADER="## What's Changed"
fi

# 按 Conventional Commits 分组生成 notes
declare -A GROUPS=(
  [feat]="✨ Features"
  [fix]="🐛 Bug Fixes"
  [docs]="📝 Documentation"
  [refactor]="♻️ Refactoring"
  [perf]="⚡ Performance"
  [test]="✅ Tests"
  [build]="🏗️ Build"
  [ci]="🔧 CI"
  [chore]="🧹 Chores"
  [other]="🔀 Other"
)

build_notes() {
  echo "# Advanced Multi Column v${VERSION}"
  echo ""
  echo "$HEADER"
  echo ""

  local log_args=("--pretty=format:%s" "--no-merges")
  [[ -n "$RANGE" ]] && log_args+=("$RANGE")

  # awk 实现分组（兼容 macOS bash 3.2 / 无关联数组）
  git log "${log_args[@]}" 2>/dev/null | awk '
    function label(t) {
      if (t == "feat")    return "✨ Features";
      if (t == "fix")     return "🐛 Bug Fixes";
      if (t == "docs")    return "📝 Documentation";
      if (t == "refactor") return "♻️ Refactoring";
      if (t == "perf")    return "⚡ Performance";
      if (t == "test")    return "✅ Tests";
      if (t == "build")   return "🏗️ Build";
      if (t == "ci")      return "🔧 CI";
      if (t == "chore")   return "🧹 Chores";
      return "🔀 Other";
    }
    {
      line = $0;
      type = "other";
      subject = line;
      if (match(line, /^[a-zA-Z]+(\([^)]*\))?!?:[[:space:]]*/)) {
        prefix = substr(line, 1, RLENGTH);
        subject = substr(line, RLENGTH + 1);
        # 提取 type（可能带 scope）
        split(prefix, parts, /[(:]/);
        type = parts[1];
        if (type !~ /^(feat|fix|docs|refactor|perf|test|build|ci|chore)$/) type = "other";
      }
      sections[label(type)] = sections[label(type)] "- " subject "\n";
    }
    END {
      order[1] = "✨ Features"; order[2] = "🐛 Bug Fixes"; order[3] = "📝 Documentation";
      order[4] = "♻️ Refactoring"; order[5] = "⚡ Performance"; order[6] = "✅ Tests";
      order[7] = "🏗️ Build"; order[8] = "🔧 CI"; order[9] = "🧹 Chores"; order[10] = "🔀 Other";
      printed = 0;
      for (i = 1; i <= 10; i++) {
        if (sections[order[i]] != "") {
          if (printed) print "";
          print "### " order[i];
          print "";
          printf "%s", sections[order[i]];
          printed = 1;
        }
      }
      if (!printed) print "_No commits_";
    }
  '
}

NOTES_FILE="$(mktemp)"
trap 'rm -f "$NOTES_FILE"' EXIT
build_notes > "$NOTES_FILE"

echo ">> Release notes 预览:"
echo "──────────────────────────────────────────────"
cat "$NOTES_FILE"
echo "──────────────────────────────────────────────"

# ── Dry run ────────────────────────────────────────────────
if $DRY_RUN; then
  echo ">> [dry-run] 将执行："
  echo "   git tag $TAG && git push origin $TAG"
  echo "   gh release create $TAG --title '$TAG' --notes-file '$NOTES_FILE' '$VSIX_FILE'"
  exit 0
fi

# ── 发布前置（dry-run 已提前返回）──────────────────────────
if ! command -v gh >/dev/null 2>&1; then
  echo "!! 需要 gh CLI：brew install gh && gh auth login" >&2
  exit 1
fi
gh auth status >/dev/null 2>&1 || { echo "!! gh 未认证：gh auth login" >&2; exit 1; }

# ── 创建 tag 并发布 ────────────────────────────────────────
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo ">> tag $TAG 已存在，复用"
else
  echo ">> 创建 tag $TAG"
  git tag "$TAG"
  git push origin "$TAG"
fi

echo ">> 创建 GitHub Release…"
gh release create "$TAG" \
  --title "$TAG" \
  --notes-file "$NOTES_FILE" \
  "$VSIX_FILE"

echo "✔ Release $TAG 已发布：https://github.com/illegal-xd/multi-column-markdown/releases/tag/$TAG"
echo "  assets: $VSIX_FILE"
