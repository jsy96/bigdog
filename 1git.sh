#!/bin/bash
# One-click: stage all, commit, push to gitee (origin main).
# Usage:
#   ./1git.sh              -> commit message defaults to "update"
#   ./1git.sh your message -> commit message is "your message"
cd "$(dirname "$0")" || exit 1
MSG="$*"
if [ -z "$MSG" ]; then MSG="update"; fi

echo "Staging changes..."
git add -A

echo "Committing: $MSG"
git commit -m "$MSG"
if [ $? -ne 0 ]; then echo "Nothing new to commit."; fi

echo "Pushing to gitee (origin main)..."
git push origin main

echo
echo "Done."
