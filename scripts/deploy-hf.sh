#!/usr/bin/env bash
# Mirror server/ into the Hugging Face Space clone, commit, and push — so the hosted server
# tracks this repo. Runs manually (`bash scripts/deploy-hf.sh`) or automatically from the
# pre-push hook (.githooks/pre-push). It's a no-op when server/ hasn't changed.
#
# The HF Space clone location defaults to a sibling `hf-space/` next to this repo; override
# with HF_SPACE_DIR=/path/to/clone.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
SRC="$ROOT/server"
DST="${HF_SPACE_DIR:-$ROOT/../hf-space}"
SPACE_URL="https://huggingface.co/spaces/roanjtaylor/ClaudeSubscription"

if [ ! -d "$DST/.git" ]; then
  echo "[deploy-hf] No HF Space clone found at: $DST" >&2
  echo "[deploy-hf] Clone it once, then retry:" >&2
  echo "  git clone $SPACE_URL \"$DST\"" >&2
  exit 1
fi

echo "[deploy-hf] Mirroring server/ -> $DST"
# Mirror src/ (remove first so deleted files don't linger), then the root deploy files.
rm -rf "$DST/src"
cp -r "$SRC/src" "$DST/src"
for f in Dockerfile .dockerignore package.json package-lock.json tsconfig.json README.md; do
  cp "$SRC/$f" "$DST/$f"
done

git -C "$DST" add -A
if git -C "$DST" diff --cached --quiet; then
  echo "[deploy-hf] No server changes to deploy."
  exit 0
fi

SHA="$(git -C "$ROOT" rev-parse --short HEAD)"
git -C "$DST" commit -m "Sync server from a_IPhoneClaude@$SHA"
echo "[deploy-hf] Pushing to Hugging Face…"
git -C "$DST" push
echo "[deploy-hf] Done — the Space will rebuild its Docker image."
