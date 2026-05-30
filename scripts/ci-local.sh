#!/usr/bin/env bash
set -euo pipefail

if [ -t 1 ]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  BOLD='\033[1m'
  RESET='\033[0m'
else
  GREEN=''
  RED=''
  BOLD=''
  RESET=''
fi

STEPS=("build" "lint" "test:unit" "test")
LABELS=("Build" "Lint" "Unit tests" "E2E tests")
RESULTS=()

run_step() {
  local label="$1"
  local script="$2"
  printf "\n${BOLD}▶ %s${RESET}\n" "$label"
  if npm run "$script" 2>&1; then
    RESULTS+=("ok")
  else
    RESULTS+=("fail")
  fi
}

for i in "${!STEPS[@]}"; do
  run_step "${LABELS[$i]}" "${STEPS[$i]}"
done

printf "\n${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
ALL_PASS=true
for i in "${!STEPS[@]}"; do
  if [[ "${RESULTS[$i]}" == "ok" ]]; then
    printf "  ${GREEN}✔${RESET} %s\n" "${LABELS[$i]}"
  else
    printf "  ${RED}✘${RESET} %s\n" "${LABELS[$i]}"
    ALL_PASS=false
  fi
done
printf "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"

if $ALL_PASS; then
  printf "${GREEN}${BOLD}All checks passed${RESET}\n\n"
  exit 0
else
  printf "${RED}${BOLD}Some checks failed${RESET}\n\n"
  exit 1
fi
