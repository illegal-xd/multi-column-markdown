#!/usr/bin/env bash
# ============================================================================
# publish-packages.sh — 构建并发布 vsix 到 GitHub Packages（npm registry）
#
# 用法:
#   GH_TOKEN=<token> ./scripts/publish-packages.sh
#
# 前置:
#   - gh CLI 已安装并认证（gh auth login），或设置 GH_TOKEN
#   - 仓库 owner: illegal-xd
#
# 行为:
#   1. npm run build && vsce package 生成 vsix
#   2. 以 scoped 包名 @<owner>/<name> 发布到 https://npm.pkg.github.com
#      （npm 包内包含 vsix 产物 + README + LICENSE）
#   3. 发布后恢复 package.json（不污染工作区）
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

OWNER="${OWNER:-illegal-xd}"
PACKAGE_NAME="multi-column-markdown"
REGISTRY="https://npm.pkg.github.com"

# ── 认证检查 ────────────────────────────────────────────────
if [[ -z "${GH_TOKEN:-}" ]]; then
  if command -v gh >/dev/null 2>&1; then
    echo ">> 使用 gh 认证 token"
    GH_TOKEN="$(gh auth token)"
  else
    echo "!! 需要 GH_TOKEN 环境变量或已登录的 gh CLI" >&2
    exit 1
  fi
fi

# ── 构建 ────────────────────────────────────────────────────
echo ">> 构建扩展…"
npm run build
VERSION="$(node -p "require('./package.json').version")"
echo ">> 版本: v${VERSION}"

echo ">> 打包 vsix…"
./node_modules/.bin/vsce package --no-dependencies

VSIX_FILE="${PACKAGE_NAME}-${VERSION}.vsix"
[[ -f "$VSIX_FILE" ]] || { echo "!! vsix 未生成: $VSIX_FILE" >&2; exit 1; }

# ── 发布到 GitHub Packages ──────────────────────────────────
echo ">> 发布 @${OWNER}/${PACKAGE_NAME}@${VERSION} → ${REGISTRY}"

# 临时构建目录（避免污染工作区 package.json）
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cp package.json "$TMP_DIR/package.json"
cp README.md "$TMP_DIR/README.md"
cp LICENSE "$TMP_DIR/LICENSE" 2>/dev/null || true
cp "$VSIX_FILE" "$TMP_DIR/"

# scoped 包名 + 发布清单（vsix 作为包内产物）
node -e "
const fs = require('fs');
const p = require('$TMP_DIR/package.json');
p.name = '@$OWNER/$PACKAGE_NAME';
p.version = '$VERSION';
p.main = undefined;
p.scripts = {};
p.devDependencies = {};
p.files = ['$VSIX_FILE', 'README.md', 'LICENSE'];
p.description = p.description || 'Multi-column markdown preview enhancement for VSCode (vsix artifact)';
fs.writeFileSync('$TMP_DIR/package.json', JSON.stringify(p, null, 2));
"

# 临时 .npmrc（GitHub Packages 认证）
cat > "$TMP_DIR/.npmrc" <<EOF
registry=${REGISTRY}
//npm.pkg.github.com/:_authToken=\${GH_TOKEN}
EOF

(
  cd "$TMP_DIR"
  GH_TOKEN="$GH_TOKEN" npm publish --access public 2>&1 | tail -5
)

echo "✔ 已发布 @${OWNER}/${PACKAGE_NAME}@${VERSION} 到 GitHub Packages"
echo "  包内产物: ${VSIX_FILE}（下载后 code --install-extension 安装）"
