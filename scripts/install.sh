#!/usr/bin/env bash
# Install jarvis-rt from this checkout: dependencies, build, the `jarvis-rt` command, models, and a check.
#   scripts/install.sh              install (safe to re-run)
#   scripts/install.sh --uninstall  remove the command (models and settings are kept; their paths are printed)
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'jarvis-rt install: %s\n' "$*" >&2; exit 1; }

# The command is a link to this checkout's build, in a folder you own (no sudo, no npm prefix changes).
BIN_DIR="${JARVIS_RT_BIN:-$HOME/.local/bin}"
LINK="$BIN_DIR/jarvis-rt"

if [[ "${1:-}" == "--uninstall" ]]; then
  if [[ -L "$LINK" ]]; then rm "$LINK"; say "Removed $LINK."; else echo "No jarvis-rt link in $BIN_DIR."; fi
  echo "Kept, delete them yourself if you like:"
  echo "  models:   ${JARVIS_RT_MODELS:-${XDG_CACHE_HOME:-$HOME/.cache}/jarvis-rt/models}"
  echo "  settings: ${XDG_CONFIG_HOME:-$HOME/.config}/jarvis-rt"
  echo "  history:  ${XDG_STATE_HOME:-$HOME/.local/state}/jarvis-rt"
  exit 0
fi

[[ "$(uname -s)" == "Darwin" ]] || echo "Note: jarvis-rt is built and tested on macOS; other systems may need work."
command -v node >/dev/null || die "Node.js 22 or newer is needed: https://nodejs.org"
major="$(node -p 'process.versions.node.split(".")[0]')"
(( major >= 22 )) || die "Node.js 22 or newer is needed (found $(node -v))."
command -v claude >/dev/null || echo "Note: the claude command isn't installed. jarvis-rt uses your Claude Code login: install Claude Code and sign in once."

say "1/4 Installing dependencies…"
npm ci --no-audit --no-fund
say "2/4 Building…"
npm run -s build
chmod +x dist/src/main.js
say "3/4 Adding the jarvis-rt command to ${BIN_DIR}…"
mkdir -p "$BIN_DIR"
if [[ -e "$LINK" && ! -L "$LINK" ]]; then die "$LINK exists and isn't a link; move it away and re-run."; fi
ln -sfn "$PWD/dist/src/main.js" "$LINK"
say "4/4 Downloading the voice and speech models (about 440 MB, once)…"
"$LINK" setup
echo
"$LINK" doctor || true
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo; echo "$BIN_DIR isn't on your PATH yet. Add this line to ~/.zshrc, then open a new terminal:"
     echo "  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
echo
say "Installed. Run jarvis-rt in any project folder and start talking."
