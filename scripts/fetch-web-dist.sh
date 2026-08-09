#!/usr/bin/env bash
# Fetch the plugin GUI (the cdp-web app) into resources/web-dist/.
#
# The GUI ships as the @cdp-wasm-suite/cdp-web npm package on GitHub Packages
# (published by cdp-web's publish.yml); the package root is cdp-web's
# self-contained static bundle. resources/web-dist/ is NOT committed — run this
# after cloning (and again to pick up a new GUI release); CI runs it before
# configuring.
#
#   scripts/fetch-web-dist.sh          # latest
#   scripts/fetch-web-dist.sh 0.1.0    # specific version
#
# Auth: GitHub Packages requires a token even for public reads. Uses
# $GITHUB_TOKEN if set (CI), else `gh auth token`. If the gh token lacks the
# packages scope (403), grant it once with:  gh auth refresh -s read:packages
set -euo pipefail

VERSION="${1:-latest}"
cd "$(dirname "$0")/.."
DEST=resources/web-dist

TOKEN="${GITHUB_TOKEN:-$(gh auth token 2>/dev/null || true)}"
if [ -z "$TOKEN" ]; then
  echo "error: no GitHub token — set GITHUB_TOKEN or run \`gh auth login\`." >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Throwaway npmrc so the registry mapping + token never touch the user config.
cat > "$TMP/npmrc" <<EOF
@cdp-wasm-suite:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=$TOKEN
EOF

npm --userconfig "$TMP/npmrc" pack "@cdp-wasm-suite/cdp-web@$VERSION" \
  --pack-destination "$TMP" --loglevel warn
tar -xzf "$TMP"/cdp-wasm-suite-cdp-web-*.tgz -C "$TMP"

rm -rf "$DEST"
mv "$TMP/package" "$DEST"
echo "✓ fetched @cdp-wasm-suite/cdp-web@$VERSION → $DEST"
