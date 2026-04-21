#!/bin/bash
# scripts/status.sh
# Quick check on build status — run from anywhere

cd "$(dirname "$0")/.."

echo "=========================================="
echo "  ServiceTitan Clone — Build Status"
echo "=========================================="
echo ""

if [ -f .build.pid ]; then
  PID=$(cat .build.pid)
  if ps -p "$PID" > /dev/null 2>&1; then
    echo "✅ Build process ALIVE (PID: $PID)"
  else
    echo "⚠️  Build process DEAD (last PID: $PID)"
  fi
else
  echo "❓ No .build.pid file — build may not have started"
fi

echo ""
echo "Latest git activity:"
git log --oneline -5 2>/dev/null || echo "  (no commits yet)"

echo ""
echo "Phase tags completed:"
git tag | grep '^phase-' | sort || echo "  (none yet)"

echo ""
echo "Current phase files:"
ls -t phases/*_GATE.md 2>/dev/null | head -3 | sed 's/^/  /'

echo ""
echo "Latest audit:"
latest_audit=$(ls -t phases/*_AUDIT_*.md 2>/dev/null | head -1)
if [ -n "$latest_audit" ]; then
  echo "  $latest_audit"
  echo ""
  grep -A 2 "^## Verdict\|^Verdict:" "$latest_audit" | head -5 | sed 's/^/    /'
fi

echo ""
echo "Latest log lines:"
tail -10 logs/build.log 2>/dev/null | sed 's/^/  /' || echo "  (no log yet)"

echo ""
echo "=========================================="
echo "Commands:"
echo "  tail -f logs/build.log      # Watch live"
echo "  touch .approve-next          # Continue to next phase"
echo "  touch .stop-build            # Stop gracefully after current step"
echo "=========================================="
