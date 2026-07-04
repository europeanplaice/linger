#!/usr/bin/env bash
set -euo pipefail

if [ -t 1 ]; then
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  BOLD='\033[1m'
  RESET='\033[0m'
else
  GREEN=''
  YELLOW=''
  BOLD=''
  RESET=''
fi

PROJECT="linger"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      if [[ $# -lt 2 ]]; then
        echo "--project requires a value" >&2
        exit 1
      fi
      PROJECT="$2"
      shift 2
      ;;
    --project=*)
      PROJECT="${1#*=}"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

case "$PROJECT" in
  linger)
    BRANCH="main"
    ;;
  linger-staging)
    BRANCH="staging"
    ;;
  *)
    echo "Unknown project '$PROJECT' (expected 'linger' or 'linger-staging')" >&2
    exit 1
    ;;
esac

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

printf "\n${BOLD}Swap Google OAuth client for Cloudflare Pages project: %s${RESET}\n" "$PROJECT"
printf "${YELLOW}This rotates GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET only — SESSION_DOMAIN is left untouched.${RESET}\n"
printf "Use this once the incoming GCP project/client is already Google-verified and tested on staging.\n\n"

read -rp "New GOOGLE_CLIENT_ID: " NEW_CLIENT_ID
if [[ -z "$NEW_CLIENT_ID" ]]; then
  echo "Client ID cannot be empty" >&2
  exit 1
fi

read -rsp "New GOOGLE_CLIENT_SECRET: " NEW_CLIENT_SECRET
printf "\n"
if [[ -z "$NEW_CLIENT_SECRET" ]]; then
  echo "Client secret cannot be empty" >&2
  exit 1
fi

printf "\nAbout to set secrets on Pages project ${BOLD}%s${RESET} and redeploy branch ${BOLD}%s${RESET}.\n" "$PROJECT" "$BRANCH"
read -rp "Continue? [y/N] " CONFIRM
if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
  echo "Aborted."
  exit 1
fi

trap 'printf "\n${YELLOW}WARNING: the swap did not complete cleanly — verify both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on %s before the next deploy (a mismatched pair will break sign-in).${RESET}\n" "$PROJECT" >&2' ERR

# Bulk upload so both secrets land in a single API call instead of two
# sequential `secret put` calls, which would otherwise leave a window
# where GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET belong to different clients.
printf '{"GOOGLE_CLIENT_ID":"%s","GOOGLE_CLIENT_SECRET":"%s"}' \
  "$(json_escape "$NEW_CLIENT_ID")" "$(json_escape "$NEW_CLIENT_SECRET")" \
  | npx wrangler pages secret bulk --project-name="$PROJECT"

unset NEW_CLIENT_SECRET
trap - ERR

printf "\n${GREEN}Secrets updated.${RESET}\n"

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
DIRTY="$(git status --porcelain 2>/dev/null || echo "")"

if [[ -n "$DIRTY" ]]; then
  printf "${YELLOW}Warning: working tree has uncommitted changes — a redeploy now would ship them to %s.${RESET}\n" "$PROJECT"
fi
if [[ "$CURRENT_BRANCH" != "$BRANCH" ]]; then
  printf "${YELLOW}Warning: current branch is '%s', not '%s' — a redeploy now would ship '%s' tagged as '%s'.${RESET}\n" "$CURRENT_BRANCH" "$BRANCH" "$CURRENT_BRANCH" "$BRANCH"
fi

read -rp "Redeploy now so the live deployment picks up the new secrets? [y/N] " REDEPLOY
if [[ "$REDEPLOY" == "y" || "$REDEPLOY" == "Y" ]]; then
  npm run build
  npx wrangler pages deploy dist --project-name="$PROJECT" --branch="$BRANCH"
  printf "\n${GREEN}${BOLD}Swap complete — %s is now serving the new OAuth client.${RESET}\n" "$PROJECT"
else
  printf "\n${YELLOW}Secrets are set but the live deployment hasn't picked them up yet — redeploy before relying on the swap.${RESET}\n"
fi
