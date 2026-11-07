#!/bin/sh
# 安装/更新 Carnet santé Helper：
#   定位或克隆仓库 → 更新代码 → 复制扩展路径到剪贴板 → 打开浏览器扩展管理页
# 人工只剩：开「开发者模式」（仅首次）→ 点「加载已解压的扩展程序」→ 粘贴路径。
set -eu

REPO=bellchu/CarnetSanteHelper
DEST="$HOME/Code/CarnetSanteHelper"

# 1. 定位或克隆仓库
if [ -f "$(pwd)/manifest.json" ] && [ -d "$(pwd)/.git" ]; then
  DIR="$(pwd)"
elif [ -d "$DEST/.git" ]; then
  DIR="$DEST"
else
  echo "→ 克隆 $REPO 到 $DEST"
  if command -v gh >/dev/null 2>&1; then
    gh repo clone "$REPO" "$DEST"
  else
    git clone "https://github.com/$REPO.git" "$DEST"
  fi
  DIR="$DEST"
fi

# 2. 更新代码（本地有改动时跳过，不报错）
if git -C "$DIR" config --get remote.origin.url >/dev/null 2>&1; then
  echo "→ 更新代码"
  git -C "$DIR" pull --ff-only || echo "  （跳过更新：本地有未提交改动或有分歧）"
fi
DIR="$(cd "$DIR" && pwd)"

# 3. 复制路径到剪贴板
CLIP=0
if command -v pbcopy >/dev/null 2>&1; then
  printf %s "$DIR" | pbcopy
  CLIP=1
elif command -v xclip >/dev/null 2>&1; then
  printf %s "$DIR" | xclip -selection clipboard
  CLIP=1
elif command -v xsel >/dev/null 2>&1; then
  printf %s "$DIR" | xsel --clipboard --input
  CLIP=1
fi

# 4. 打开扩展管理页（优先 Chrome，其次 Edge）
if [ "$(uname)" = "Darwin" ]; then
  if open -Ra "Google Chrome" 2>/dev/null; then
    open -a "Google Chrome" "chrome://extensions"
  elif open -Ra "Microsoft Edge" 2>/dev/null; then
    open -a "Microsoft Edge" "edge://extensions"
  else
    echo "（未找到 Chrome/Edge，请手动打开扩展管理页）"
  fi
else
  OPENED=0
  for b in google-chrome google-chrome-stable microsoft-edge; do
    if command -v "$b" >/dev/null 2>&1; then
      "$b" "chrome://extensions" >/dev/null 2>&1 &
      OPENED=1
      break
    fi
  done
  if [ "$OPENED" = "0" ]; then
    echo "（未找到 Chrome/Edge，请手动打开扩展管理页）"
  fi
fi

echo
echo "✅ 代码就绪：$DIR"
if [ "$CLIP" = "1" ]; then
  echo "📋 扩展路径已复制到剪贴板"
fi
echo
echo "接下来（首次只需一次）："
echo "  1. 开启页面右上角「开发者模式」"
echo "  2. 点「加载已解压的扩展程序」"
echo "  3. 粘贴路径（macOS: ⌘⇧V）并回车"
echo
echo "以后更新：重跑本脚本，然后在扩展卡片上点「重新加载 ↻」。"
