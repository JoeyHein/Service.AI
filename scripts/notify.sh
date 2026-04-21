#!/bin/bash
# scripts/notify.sh
# Sends notifications via ntfy.sh or Slack webhook

notify() {
  local message="$1"
  local priority="${2:-default}"
  local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
  local full_message="[$timestamp] $message"

  # Always log locally
  echo "$full_message" | tee -a logs/notifications.log

  # ntfy.sh (no signup required)
  if [ -n "${NTFY_TOPIC:-}" ]; then
    curl -s -X POST \
      -H "Priority: $priority" \
      -H "Title: ServiceTitan Build" \
      -d "$full_message" \
      "https://ntfy.sh/${NTFY_TOPIC}" > /dev/null 2>&1 || true
  fi

  # Slack webhook
  if [ -n "${SLACK_WEBHOOK:-}" ]; then
    curl -s -X POST \
      -H 'Content-Type: application/json' \
      -d "{\"text\":\"$full_message\"}" \
      "$SLACK_WEBHOOK" > /dev/null 2>&1 || true
  fi
}

# Allow calling from CLI: ./scripts/notify.sh "message" [priority]
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  notify "$@"
fi
