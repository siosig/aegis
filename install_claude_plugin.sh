#!/usr/bin/env bash
# Install this working copy of Aegis as a Claude Code plugin (user scope).
#
# The plugin registers two MCP servers that run this repository's build:
#   aegis        -> node <repo>/dist/main.js --surface agent
#   aegis-admin  -> node <repo>/dist/main.js --surface admin
#
# Claude Code copies a plugin directory into its cache on install, so the plugin
# is generated in a small directory (.claude-plugin-local/, gitignored) that only
# holds the manifest. The servers point at this repository by absolute path:
# rebuilding (pnpm run build) takes effect on the next MCP start without reinstalling.
#
# Usage: ./install_claude_plugin.sh [--build]
#   --build  run `pnpm run build` before installing (otherwise dist/main.js must exist)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="${REPO_DIR}/.claude-plugin-local"
MARKETPLACE_NAME="${AEGIS_MARKETPLACE_NAME:-aegis-local}"
PLUGIN_NAME="aegis"
MAIN_JS="${REPO_DIR}/dist/main.js"

_require() {
  if ! command -v "$1" &>/dev/null; then
    echo "ERROR: '$1' not found. Please install it and try again." >&2
    exit 1
  fi
  echo "✓ $1: $(command -v "$1")"
}

_require git
_require claude
_require node

BUILD=0
for arg in "$@"; do
  case "$arg" in
    --build) BUILD=1 ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "ERROR: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# ── 1. Build ─────────────────────────────────────────────────────────────────
if [[ "$BUILD" -eq 1 ]]; then
  _require pnpm
  echo "→ building (pnpm run build)"
  (cd "$REPO_DIR" && pnpm run build)
fi
if [[ ! -f "$MAIN_JS" ]]; then
  echo "ERROR: ${MAIN_JS} not found. Run 'pnpm install && pnpm run build' or pass --build." >&2
  exit 1
fi

# ── 2. Resolve the node binary ───────────────────────────────────────────────
# A version-manager shim (nodenv, etc.) picks the Node version from the MCP
# server's cwd (the user's project), which may pin an older Node. Resolve the
# real binary from this repository so the server always runs on a supported Node.
NODE_BIN="$(cd "$REPO_DIR" && command -v node)"
if command -v nodenv &>/dev/null; then
  NODE_BIN="$(cd "$REPO_DIR" && nodenv which node)"
fi
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 26 ]]; then
  echo "ERROR: Node.js >= 26 is required (found $("$NODE_BIN" -v) at ${NODE_BIN})." >&2
  exit 1
fi
echo "✓ node binary: ${NODE_BIN} ($("$NODE_BIN" -v))"

# ── 3. Generate the plugin directory ─────────────────────────────────────────
VERSION="$(cd "$REPO_DIR" && node -p 'require("./package.json").version')"
REV="$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
mkdir -p "${PLUGIN_DIR}/.claude-plugin"

# The MCP servers are declared inline in plugin.json (not in a .mcp.json file),
# so opening Claude Code inside the plugin directory does not also load them
# as project-scope servers.
NODE_BIN="$NODE_BIN" MAIN_JS="$MAIN_JS" VERSION="$VERSION" REV="$REV" \
PLUGIN_NAME="$PLUGIN_NAME" MARKETPLACE_NAME="$MARKETPLACE_NAME" PLUGIN_DIR="$PLUGIN_DIR" \
node -e '
const fs = require("node:fs");
const path = require("node:path");
const e = process.env;
const server = (surface) => ({ type: "stdio", command: e.NODE_BIN, args: [e.MAIN_JS, "--surface", surface] });
const description = `Aegis MCP servers (agent / admin) from the local build (${e.REV})`;
const plugin = {
  name: e.PLUGIN_NAME,
  version: e.VERSION,
  description,
  mcpServers: { aegis: server("agent"), "aegis-admin": server("admin") },
};
const marketplace = {
  name: e.MARKETPLACE_NAME,
  owner: { name: "local" },
  metadata: { description: "Local marketplace for the Aegis plugin built from this working copy." },
  plugins: [{ name: e.PLUGIN_NAME, source: "./", description }],
};
const dir = path.join(e.PLUGIN_DIR, ".claude-plugin");
fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(plugin, null, 2) + "\n");
fs.writeFileSync(path.join(dir, "marketplace.json"), JSON.stringify(marketplace, null, 2) + "\n");
'
echo "✓ plugin generated: ${PLUGIN_DIR} (version ${VERSION}, ${REV})"

# ── 4. Register marketplace ──────────────────────────────────────────────────
if claude plugin marketplace list 2>/dev/null | grep -q "❯ ${MARKETPLACE_NAME}$"; then
  echo "→ re-registering marketplace '${MARKETPLACE_NAME}'"
  claude plugin marketplace remove "${MARKETPLACE_NAME}"
fi
claude plugin marketplace add "${PLUGIN_DIR}"
echo "✓ marketplace '${MARKETPLACE_NAME}': registered (${PLUGIN_DIR})"

# ── 5. Reinstall plugin ──────────────────────────────────────────────────────
if claude plugin list 2>/dev/null | grep -q "❯ ${PLUGIN_NAME}@${MARKETPLACE_NAME}"; then
  echo "→ uninstalling existing '${PLUGIN_NAME}@${MARKETPLACE_NAME}'"
  claude plugin uninstall "${PLUGIN_NAME}@${MARKETPLACE_NAME}" --yes
fi
echo "→ installing '${PLUGIN_NAME}@${MARKETPLACE_NAME}'"
claude plugin install "${PLUGIN_NAME}@${MARKETPLACE_NAME}"
echo "✓ '${PLUGIN_NAME}@${MARKETPLACE_NAME}': installed"

echo ""
echo "Installation complete. Restart Claude Code to activate the plugin."
