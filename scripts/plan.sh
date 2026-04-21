#!/bin/bash
# scripts/plan.sh
# Run this INTERACTIVELY first to produce the planning package.
# This is the only part that requires your attention.

cd "$(dirname "$0")/.."

cat << 'EOF'
==========================================
  ServiceTitan Clone — Planning Session
==========================================

This will launch Claude Code interactively. You will answer
questions for ~30-60 minutes to produce the planning package.

When the planning session is complete, exit Claude Code (Ctrl+D)
and run ./scripts/launch.sh to start the autonomous build.

Press Enter to launch Claude Code...
EOF

read

# Launch Claude Code with the planning prompt preloaded
claude --dangerously-skip-permissions << 'PROMPT'
We are building a ServiceTitan-style business management system as a STANDALONE product.

IMPORTANT CONTEXT:
- This is a standalone system with its own database
- It will NOT directly integrate with Microsoft Business Central
- It MAY later be connected to an external portal that separately integrates with BC
- Design the API and data model to be ERP-agnostic with clean extension points

Before any code is written, produce a complete planning package in the docs/ folder.
Ask me clarifying questions ONE AT A TIME. After I answer each, acknowledge briefly
and ask the next. Once you have enough information, produce these files:

1. docs/PRD.md — product requirements, user personas (admin, dispatcher, tech, CSR,
   customer), core workflows, must-have v1 features, explicitly deferred v2 features

2. docs/ARCHITECTURE.md — stack choice with justification, service boundaries,
   data model (tables + key columns + relationships), API contracts style
   (REST/GraphQL/tRPC), auth model, multi-tenancy approach, deployment target,
   observability strategy

3. docs/PHASES.md — ordered list of 10-15 phases. Each phase heading must start
   with "## phase_<snake_case_name>" so the runner can parse it. Each phase must
   be a shippable vertical slice, not a horizontal layer.

4. docs/TASKS.md — every task tagged with phase:<name>, dependencies, acceptance
   criteria as checkable assertions, estimated LOC. Format per
   .claude/agents/planner.md.

5. docs/TEST_STRATEGY.md — unit/integration/e2e conventions, test data approach,
   what "works" means per phase, performance baselines, security test requirements

6. docs/EVOLUTION.md — what the system should learn and adapt during the build,
   what changes the evolver is and is NOT allowed to make

7. CLAUDE.md — project conventions, required patterns, forbidden patterns,
   commit message format, file/folder layout, coding standards

Start by asking me the FIRST question. Focus on: which core workflows must v1
cover, what the MVP user journey looks like end-to-end, and my stack preferences.

After the questions are done and before writing the docs, summarize your
understanding and ask me to confirm. Then write all 7 files.
PROMPT

echo ""
echo "=========================================="
echo "Planning session ended."
echo ""
echo "Check that these files exist:"
for f in docs/PRD.md docs/ARCHITECTURE.md docs/PHASES.md docs/TASKS.md \
         docs/TEST_STRATEGY.md docs/EVOLUTION.md CLAUDE.md; do
  if [ -f "$f" ]; then
    echo "  ✅ $f"
  else
    echo "  ❌ $f — MISSING"
  fi
done
echo ""
echo "If all files exist and you're ready, run: ./scripts/launch.sh"
echo "=========================================="
