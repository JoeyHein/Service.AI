#!/bin/bash
# scripts/launch.sh
# ONE COMMAND TO START THE AUTONOMOUS BUILD
# Run this after ./scripts/plan.sh has produced the planning package.

cd "$(dirname "$0")/.."

# Sanity checks
echo "Running pre-flight checks..."

for f in docs/PRD.md docs/ARCHITECTURE.md docs/PHASES.md docs/TASKS.md CLAUDE.md; do
  if [ ! -f "$f" ]; then
    echo "❌ Missing required file: $f"
    echo "   Run ./scripts/plan.sh first."
    exit 1
  fi
done

if [ ! -f .env ]; then
  echo "❌ Missing .env file"
  echo "   Copy .env.example to .env and fill in ANTHROPIC_API_KEY"
  exit 1
fi

set -a
source .env
set +a

if [ -z "${ANTHROPIC_API_KEY:-}" ] || [ "$ANTHROPIC_API_KEY" = "sk-ant-..." ]; then
  echo "❌ ANTHROPIC_API_KEY not configured in .env"
  exit 1
fi

echo "✅ Pre-flight checks passed"
echo ""

# Confirm
cat << EOF
==========================================
  READY TO LAUNCH AUTONOMOUS BUILD

  This will:
  - Start building continuously in the background
  - Run for hours or days unattended
  - Notify you at each phase gate via ${NTFY_TOPIC:+ntfy} ${SLACK_WEBHOOK:+slack}
  - Halt and notify if a phase fails 5 correction cycles

  Logs:      tail -f logs/build.log
  Status:    ./scripts/status.sh
  Continue:  touch .approve-next
  Stop:      touch .stop-build

==========================================
EOF

read -p "Start the build? (yes/no): " confirm
if [ "$confirm" != "yes" ]; then
  echo "Aborted."
  exit 0
fi

# Launch
mkdir -p logs
nohup ./scripts/run-build.sh > logs/build.log 2>&1 &
BUILD_PID=$!
echo $BUILD_PID > .build.pid

echo ""
echo "🚀 Build started with PID $BUILD_PID"
echo ""
echo "You can now close this terminal safely."
echo "Check progress anytime with: ./scripts/status.sh"
echo ""
