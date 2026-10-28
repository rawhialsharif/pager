#!/usr/bin/env bash
# Auto-deploy: run every minute by pager-update.timer.
# If GitHub has a new commit, test it in a separate folder first. Only if the tests pass,
# switch the live app to it and restart. A commit that fails is remembered and skipped.
#
# Settings (environment variables, set by the systemd unit):
#   APP_DIR   git checkout of the repo           (default /opt/pager)
#   BRANCH    branch to follow                   (default main)
#   RUN_AS    user that owns APP_DIR             (default pager; empty = current user)
#   SERVICE   systemd service to restart         (default pager)
#   STATE_DIR where the last failed commit is kept (default /var/lib/pager)
#   RESTART_CMD  override the restart command (used by tests)

APP_DIR="${APP_DIR:-/opt/pager}"
BRANCH="${BRANCH:-main}"
RUN_AS="${RUN_AS-pager}"
SERVICE="${SERVICE:-pager}"
STATE_DIR="${STATE_DIR:-/var/lib/pager}"
FAILED_FILE="$STATE_DIR/last-failed-commit"
TEST_DIR=""

as_owner() {
  if [[ -n "$RUN_AS" && "$(id -un)" != "$RUN_AS" ]]; then
    runuser -u "$RUN_AS" -- "$@"
  else
    "$@"
  fi
}

cleanup() {
  if [[ -n "$TEST_DIR" ]]; then
    as_owner git -C "$APP_DIR" worktree remove --force "$TEST_DIR" >/dev/null 2>&1 || true
    rm -rf "$TEST_DIR" "$TEST_DIR.log"
    as_owner git -C "$APP_DIR" worktree prune >/dev/null 2>&1 || true
  fi
}

main() {
  set -euo pipefail
  trap cleanup EXIT

  as_owner git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  local current latest
  current="$(as_owner git -C "$APP_DIR" rev-parse HEAD)"
  latest="$(as_owner git -C "$APP_DIR" rev-parse "origin/$BRANCH")"
  [[ "$current" == "$latest" ]] && return 0

  if [[ -f "$FAILED_FILE" && "$(cat "$FAILED_FILE")" == "$latest" ]]; then
    return 0 # already tested this commit and it failed; wait for the next one
  fi

  echo "New commit ${latest:0:7} (running ${current:0:7}). Testing it before deploying."
  TEST_DIR="$(as_owner mktemp -d)"
  as_owner git -C "$APP_DIR" worktree add --quiet --force --detach "$TEST_DIR" "$latest"

  if ! (cd "$TEST_DIR/digital-pager" && as_owner npm test --silent >"$TEST_DIR.log" 2>&1); then
    echo "Tests failed for ${latest:0:7}. Keeping ${current:0:7} running. Failing tests:"
    grep -E '^not ok|^# (pass|fail)' "$TEST_DIR.log" || tail -n 20 "$TEST_DIR.log" || true
    mkdir -p "$STATE_DIR"
    echo "$latest" >"$FAILED_FILE"
    return 1
  fi
  rm -f "$FAILED_FILE"

  as_owner git -C "$APP_DIR" reset --quiet --hard "$latest"
  if [[ -n "${RESTART_CMD:-}" ]]; then
    eval "$RESTART_CMD"
  else
    systemctl restart "$SERVICE"
  fi
  echo "Deployed ${latest:0:7}."
}

# Everything runs inside functions, which bash reads in full before starting, so it's
# safe for this script to update its own file in the middle of a run.
main "$@"
exit $?
