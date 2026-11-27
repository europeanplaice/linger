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

QUICK=false
for arg in "$@"; do
  case "$arg" in
    --quick|-q) QUICK=true ;;
    *)
      echo "Usage: $0 [--quick|-q]" >&2
      exit 2
      ;;
  esac
done

if $QUICK; then
  printf "\n${BOLD}▶ Quick mode: lint + changed unit tests${RESET}\n"
  npm run lint
  npx vitest run --changed
  printf "\n${GREEN}${BOLD}Quick checks passed${RESET}\n\n"
  exit 0
fi

TMPDIR_LOGS="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_LOGS"' EXIT

LABELS=()
RESULTS=()

run_sync() {
  local label="$1"
  shift
  printf "\n${BOLD}▶ %s${RESET}\n" "$label"
  LABELS+=("$label")
  if "$@" 2>&1; then
    RESULTS+=("ok")
  else
    RESULTS+=("fail")
  fi
}

# 1. Build first so downstream build/E2E checks can reuse dist/ without rebuilding.
run_sync "Build" npm run build

# 2. Run independent checks in parallel.
printf "\n${BOLD}▶ Running parallel checks (Lint, Audit, Unit, Build split, Deployment, CI, Privacy, Workers)...${RESET}\n"

PAR_LABELS=(
  "Lint"
  "Audit"
  "Unit tests"
  "Bundle split tests"
  "Deployment checker tests"
  "CI configuration tests"
  "Privacy compliance tests"
  "Workflows Worker tests"
)
PAR_CMDS=(
  "npm run lint"
  "npm run audit"
  "npm run test:unit"
  "USE_EXISTING_DIST=1 npm run test:build"
  "npm run test:deployment"
  "npm run test:ci"
  "npm run test:privacy"
  "SKIP_PRIVACY_TESTS=1 npm run test:workers"
)
PAR_PIDS=()

for i in "${!PAR_CMDS[@]}"; do
  log_file="$TMPDIR_LOGS/step-$i.log"
  (eval "${PAR_CMDS[$i]}" >"$log_file" 2>&1) &
  PAR_PIDS+=($!)
done

for i in "${!PAR_PIDS[@]}"; do
  LABELS+=("${PAR_LABELS[$i]}")
  if wait "${PAR_PIDS[$i]}"; then
    RESULTS+=("ok")
  else
    RESULTS+=("fail")
    printf "\n${RED}${BOLD}✘ %s failed:${RESET}\n" "${PAR_LABELS[$i]}"
    cat "$TMPDIR_LOGS/step-$i.log"
  fi
done

# 3. E2E tests (reuse dist/ built in step 1).
run_sync "E2E tests" env USE_EXISTING_DIST=1 npm test

printf "\n${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
ALL_PASS=true
for i in "${!LABELS[@]}"; do
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
