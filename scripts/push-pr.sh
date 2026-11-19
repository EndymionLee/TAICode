#!/usr/bin/env bash
# 一键 fork + push + 向上游提 PR
#
# 前置(二选一):
#   1) 安装 GitHub CLI 并登录:  winget install GitHub.cli && gh auth login
#   2) 或导出 token:             export GITHUB_TOKEN=ghp_xxx (需 repo/fork 权限)
#
# 用法:  bash scripts/push-pr.sh
set -euo pipefail
cd "$(dirname "$0")/.."

UPSTREAM="EndymionLee/TAICode"
BRANCH="perf/cache-and-pipeline"

if ! command -v gh >/dev/null 2>&1; then
  echo "未找到 gh CLI。安装: winget install GitHub.cli && gh auth login"
  echo "或 export GITHUB_TOKEN=... 后重试(需配合 curl 手动流程)"
  exit 1
fi
gh auth status >/dev/null 2>&1 || { echo "请先: gh auth login"; exit 1; }

USER="$(gh api user -q .login)"
echo "▸ GitHub 账号: $USER"

# 1. fork(已存在则复用)
gh repo fork "$UPSTREAM" --clone=false >/dev/null 2>&1 || true
sleep 2

# 2. 分支 + 推送
git checkout -b "$BRANCH" 2>/dev/null || git checkout "$BRANCH"
git remote remove fork >/dev/null 2>&1 || true
git remote add fork "https://github.com/$USER/TAICode.git"
git push -u fork "$BRANCH"

# 3. 开 PR
gh pr create --repo "$UPSTREAM" \
  --head "$USER:$BRANCH" \
  --base master \
  --title "[优化+修复] 缓存命中与任务效率全链优化(E2E 31s→14s, 命中率80.3%), 附7项缺陷修复与77例测试" \
  --body-file scripts/PR_BODY.md

echo "▸ PR 已创建"
