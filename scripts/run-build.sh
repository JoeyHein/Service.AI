#!/bin/bash
# scripts/run-build.sh
# Autonomous phase-gated build runner

set -uo pipefail
cd "$(dirname "$0")/.."

source scripts/notify.sh

MAX_CORRECTION_CYCLES=5
LOG_DIR="logs"
mkdir -p "$LOG_DIR"

# ============================================================
# SANITY CHECKS
# ============================================================

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ERROR: ANTHROPIC_API_KEY not set" >&2
  exit 1
fi

if ! command -v claude &> /dev/null; then
  echo "ERROR: claude CLI not installed" >&2
  exit 1
fi

if [ ! -f "docs/PHASES.md" ]; then
  echo "ERROR: docs/PHASES.md not found. Complete the planning phase first." >&2
  exit 1
fi

# ============================================================
# HELPERS
# ============================================================

run_claude() {
  local prompt="$1"
  local log_file="$2"
  echo "▶️  $(date '+%H:%M:%S') Running: ${prompt:0:80}..." | tee -a "$LOG_DIR/build.log"
  claude -p "$prompt" \
    --dangerously-skip-permissions \
    --output-format stream-json \
    --verbose 2>&1 | tee -a "$log_file" | tee -a "$LOG_DIR/build.log"
}

extract_phases() {
  # Extract phase identifiers from docs/PHASES.md
  # Expects lines like: "## Phase 1: Foundation" or "### phase_foundation"
  grep -oE '^(##|###)\s+(Phase\s+[0-9]+|phase_[a-z_]+)' docs/PHASES.md \
    | sed -E 's/^#+\s+//;s/Phase\s+([0-9]+).*/phase_\1/;s/:\s+.*$//' \
    | tr '[:upper:]' '[:lower:]' \
    | awk '!seen[$0]++'
}

wait_for_approval() {
  local phase="$1"
  if [ "${AUTO_APPROVE_PHASES:-false}" = "true" ]; then
    notify "▶️ AUTO_APPROVE enabled — continuing to next phase" "default"
    return 0
  fi

  notify "⏸️  GATE REACHED: $phase complete. Run \`touch .approve-next\` to continue." "high"
  echo ""
  echo "=========================================="
  echo "  PHASE $phase COMPLETE"
  echo "  Review: phases/${phase}_GATE_REVIEW.md"
  echo "  Audit:  phases/${phase}_AUDIT_*.md"
  echo ""
  echo "  To continue:  touch .approve-next"
  echo "  To stop:      touch .stop-build"
  echo "=========================================="

  while true; do
    if [ -f .approve-next ]; then
      rm .approve-next
      notify "✅ Approved — starting next phase" "default"
      return 0
    fi
    if [ -f .stop-build ]; then
      rm .stop-build
      notify "🛑 Build stopped by user request" "high"
      exit 0
    fi
    sleep 30
  done
}

# ============================================================
# MAIN LOOP
# ============================================================

notify "🚀 Autonomous build started at $(date)" "default"

# Initial commit if repo is fresh
git add -A 2>/dev/null || true
git diff --cached --quiet || git commit -m "chore: initial planning artifacts" || true

# Push planning artifacts to GitHub if remote is configured
if git remote get-url origin >/dev/null 2>&1; then
  notify "⬆️  Pushing planning artifacts to GitHub" "default"
  git push origin HEAD 2>&1 | tee -a "$LOG_DIR/build.log" || notify "⚠️ initial push failed" "high"
fi

PHASES=$(extract_phases)
if [ -z "$PHASES" ]; then
  notify "❌ No phases found in docs/PHASES.md — aborting" "urgent"
  exit 1
fi

echo "Phases to execute:"
echo "$PHASES" | sed 's/^/  - /'
echo ""

PHASE_NUM=0
TOTAL_PHASES=$(echo "$PHASES" | wc -l)

for phase in $PHASES; do
  PHASE_NUM=$((PHASE_NUM + 1))
  phase_log="$LOG_DIR/${phase}.log"

  notify "📦 [$PHASE_NUM/$TOTAL_PHASES] Starting phase: $phase" "default"

  # ---- Stage 0: Write gate criteria ----
  run_claude "You are the planner. Read docs/PHASES.md and docs/TASKS.md. \
Write phases/${phase}_GATE.md with measurable exit criteria for phase '$phase'. \
Include sections: Must Pass (BLOCKERS), Must Improve Over Previous Phase, and \
Verification Method for each criterion. Every checkbox must be verifiable by \
running a specific command or reading a specific file." \
    "$phase_log"

  # ---- Stage 1: Build all tasks in phase ----
  notify "🔨 Phase $phase: building" "default"
  run_claude "You are the orchestrator. Execute all tasks tagged phase:$phase in docs/TASKS.md. \
For EACH task: (1) invoke test-writer to write failing tests, (2) invoke builder to implement, \
(3) run tests until green, (4) git commit. Do not stop until every task in this phase is \
implemented, tested, and committed. Read CLAUDE.md and docs/LESSONS.md first." \
    "$phase_log"

  # ---- Stages 2-4: Test → Audit → Correct, up to 5 cycles ----
  PASSED=false
  for cycle in $(seq 1 $MAX_CORRECTION_CYCLES); do
    notify "🔍 Phase $phase: test+audit cycle $cycle" "default"

    # Test
    run_claude "You are the test-runner. Execute the full test suite for phase $phase \
including unit, integration, e2e, performance baseline, and security scan. \
Write phases/${phase}_TEST_RESULTS_${cycle}.md per your output format." \
      "$phase_log"

    # Audit
    run_claude "You are the auditor. Adversarially audit phase $phase against \
phases/${phase}_GATE.md. Actually run the system — hit endpoints, query the DB, \
check logs. Be brutally honest. Write phases/${phase}_AUDIT_${cycle}.md per your \
output format. End with 'Verdict: PASS' or 'Verdict: FAIL'." \
      "$phase_log"

    # Parse verdict
    audit_file="phases/${phase}_AUDIT_${cycle}.md"
    if [ -f "$audit_file" ] && grep -qE "^Verdict:\s*PASS|^##\s*Verdict\s*$[[:space:]]*PASS|Verdict\s*\*\*?\s*:\s*PASS" "$audit_file"; then
      notify "✅ Phase $phase audit PASSED on cycle $cycle" "default"
      PASSED=true
      break
    fi

    notify "⚠️  Phase $phase audit FAILED cycle $cycle — correcting" "default"

    # Correct
    run_claude "You are the corrector. Read phases/${phase}_AUDIT_${cycle}.md. \
Fix every BLOCKER and MAJOR issue at the root cause. Add regression tests for each. \
Write phases/${phase}_CORRECTION_${cycle}.md per your output format." \
      "$phase_log"
  done

  if [ "$PASSED" != "true" ]; then
    notify "🛑 STUCK: Phase $phase failed $MAX_CORRECTION_CYCLES correction cycles. \
Human review required. Check phases/${phase}_AUDIT_*.md" "urgent"
    exit 1
  fi

  # ---- Stage 5: Gate review ----
  notify "🏁 Phase $phase: final gate review" "default"
  run_claude "You are the reviewer. Perform final gate review on phase $phase against \
phases/${phase}_GATE.md. Verify every checkbox with concrete evidence (run commands, \
hit endpoints, inspect files). Write phases/${phase}_GATE_REVIEW.md. End with \
'Gate Decision: APPROVED' or 'Gate Decision: REJECTED'." \
    "$phase_log"

  gate_review="phases/${phase}_GATE_REVIEW.md"
  if ! grep -qE "Gate Decision:\s*APPROVED|APPROVED\s*$" "$gate_review" 2>/dev/null; then
    notify "🛑 GATE REJECTED for phase $phase. Check $gate_review" "urgent"
    exit 1
  fi

  # Tag and push to GitHub
  git tag "phase-${phase}-complete" 2>/dev/null || true
  if git remote get-url origin >/dev/null 2>&1; then
    notify "⬆️  Pushing phase $phase to GitHub" "default"
    git push origin HEAD 2>&1 | tee -a "$phase_log" || notify "⚠️ git push failed for $phase" "high"
    git push origin "phase-${phase}-complete" 2>&1 | tee -a "$phase_log" || true
  fi

  # ---- Evolution pass ----
  notify "🧬 Phase $phase: evolution pass" "default"
  run_claude "You are the evolver. Review phase $phase's audits, corrections, and gate \
review. Identify patterns. Update CLAUDE.md, docs/LESSONS.md, and agent prompts as \
needed. Write phases/${phase}_EVOLUTION.md. Commit with message 'chore(evolution): \
after $phase'." \
    "$phase_log"

  # Push evolution commits
  if git remote get-url origin >/dev/null 2>&1; then
    git push origin HEAD 2>&1 | tee -a "$phase_log" || true
  fi

  notify "✅ Phase $phase COMPLETE ($PHASE_NUM/$TOTAL_PHASES)" "default"

  # Human checkpoint (or auto-continue)
  wait_for_approval "$phase"
done

notify "🎉 BUILD COMPLETE at $(date). All $TOTAL_PHASES phases passed their gates." "high"
