#!/usr/bin/env bash
# push-pr-api.sh — 无 gh CLI 的 fork+push+PR 全流程 (REST API + 设备流 token)
# 前置: .device-token 存在 (scripts/device-poll.ts 产出)
# 用法: bash scripts/push-pr-api.sh
set -euo pipefail
cd "$(dirname "$0")/.."

UPSTREAM="EndymionLee/TAICode"
BRANCH="perf/cache-and-pipeline"
TOKEN="$(cat .device-token)"
API="https://api.github.com"

[ -n "$TOKEN" ] || { echo "缺 .device-token"; exit 1; }

# 1. 身份
USER="$(curl -s --max-time 20 -H "Authorization: Bearer $TOKEN" "$API/user" | python -c "import json,sys;print(json.load(sys.stdin).get('login',''))")"
[ -n "$USER" ] || { echo "token 无效"; exit 1; }
echo "▸ GitHub 账号: $USER"

# 2. fork (已存在也返回成功/冲突, 均继续)
echo "▸ fork $UPSTREAM ..."
curl -s --max-time 30 -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  "$API/repos/$UPSTREAM/forks" -d '{}' -o /dev/null || true
sleep 6

# 3. push — token 走一次性 extraHeader, 不落任何配置
git remote remove fork >/dev/null 2>&1 || true
git remote add fork "https://github.com/$USER/TAICode.git"
echo "▸ push $BRANCH ..."
git -c "http.extraHeader=Authorization: Bearer $TOKEN" push -u fork "$BRANCH"

# 4. PR
echo "▸ 创建 PR ..."
curl -s --max-time 30 -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  "$API/repos/$UPSTREAM/pulls" \
  -d "$(python -c "
import json,io
print(json.dumps({
  'title': '[优化+修复] 缓存命中与任务效率全链优化(E2E 31s→7s, 命中率80.3%), 附7项缺陷修复与85例测试',
  'head': '$USER:$BRANCH',
  'base': 'master',
  'body': io.open('scripts/PR_BODY.md', encoding='utf-8').read(),
}, ensure_ascii=False))
")" | python -c "import json,sys;j=json.load(sys.stdin);print('PR_URL:', j.get('html_url') or j.get('message'))"
