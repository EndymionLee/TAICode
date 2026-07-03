#!/bin/bash
# TAICode 代码行数统计
# 用法: bash scripts/count-lines.sh

SRC="d:/MyC/AILearn/TAICode/src"

echo "=== TAICode 代码统计 ==="
echo ""

# 总行数
total=$(find "$SRC" \( -name "*.ts" -o -name "*.tsx" \) -exec cat {} + 2>/dev/null | wc -l)
files=$(find "$SRC" \( -name "*.ts" -o -name "*.tsx" \) | wc -l)
echo "TypeScript 源文件: ${files// /} 个"
echo "总代码行数:       ${total// /} 行"
echo ""

# 按模块
echo "--- 按模块 ---"
for d in "$SRC"/*/; do
  name=$(basename "$d")
  lines=$(find "$d" \( -name "*.ts" -o -name "*.tsx" \) -exec cat {} + 2>/dev/null | wc -l)
  printf "  %-20s %s 行\n" "$name" "${lines// /}"
done

# 按子模块 (core 内部)
echo ""
echo "--- core 子模块 ---"
for d in "$SRC/core/"*/; do
  name=$(basename "$d")
  lines=$(find "$d" \( -name "*.ts" -o -name "*.tsx" \) -exec cat {} + 2>/dev/null | wc -l)
  printf "  core/%-15s %s 行\n" "$name" "${lines// /}"
done

echo ""
echo "--- 最大文件 Top 10 ---"
find "$SRC" \( -name "*.ts" -o -name "*.tsx" \) -exec wc -l {} + 2>/dev/null \
  | sort -rn | head -11 | tail -10 \
  | awk '{printf "  %-50s %s 行\n", $2, $1}'
