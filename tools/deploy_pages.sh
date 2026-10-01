#!/usr/bin/env bash
# Deploys one commit to Cloudflare Pages: builds the site from a clean archive
# of it (tools/build_site.mjs: the tree, plus the bundled scripts and the
# content-hashed copies of data/ under assets/) and uploads that. The site is
# the committed tree: nothing from the working directory (untracked scripts,
# dumps, node_modules, edits not yet committed) is uploaded.
#
# The build needs esbuild, a dev dependency: `npm install` once in the clone.
#
#   tools/deploy_pages.sh [ref] [branch]
#     ref     the commit to deploy (default HEAD)
#     branch  the Pages branch it is deployed as (default: ref's branch name).
#             The project's production branch updates the production site;
#             any other name gets a preview at <branch>.<project>.pages.dev.
#
# Environment:
#   PAGES_PROJECT           the Pages project (default: telescope)
#   CLOUDFLARE_ACCOUNT_ID   needed where wrangler cannot ask (CI, or a login
#                           with several accounts); a local login that has
#                           deployed before already has it cached
#   CLOUDFLARE_API_TOKEN    instead of a local `wrangler login` (CI)
set -euo pipefail

ref="${1:-HEAD}"
root="$(git rev-parse --show-toplevel)"
sha="$(git -C "$root" rev-parse --verify "${ref}^{commit}")"
branch="${2:-$(git -C "$root" rev-parse --abbrev-ref "$ref")}"
if [ "$branch" = HEAD ]; then
	echo "deploy_pages: $ref is not a branch; pass the Pages branch name as the second argument" >&2
	exit 2
fi
project="${PAGES_PROJECT:-telescope}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
tree="$work/tree" site="$work/site"
mkdir "$tree"
git -C "$root" archive "$sha" | tar -x -C "$tree"
# The commit's own build script, with this clone's node_modules.
if ! node -e "require('module').createRequire('$root/')('esbuild')" 2>/dev/null; then
	echo "deploy_pages: esbuild is not installed; run 'npm install' in $root" >&2
	exit 1
fi
ln -s "$root/node_modules" "$tree/node_modules"
node "$tree/tools/build_site.mjs" --src "$tree" --out "$site"

# wrangler remembers the account a project was last deployed to next to the
# node_modules it ran from; a temp directory has neither.
cache="$root/node_modules/.cache/wrangler/pages.json"
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ] && [ -f "$cache" ]; then
	CLOUDFLARE_ACCOUNT_ID="$(sed -n 's/.*"account_id": *"\([^"]*\)".*/\1/p' "$cache")"
	export CLOUDFLARE_ACCOUNT_ID
fi

message="$(git -C "$root" log -1 --format=%s "$sha")"
echo "deploy_pages: $(git -C "$root" log -1 --format='%h %s' "$sha") -> $project, branch $branch"
# Run from the build: wrangler reads the git state of the directory it runs
# in, and the checkout's (untracked files, edits) says nothing about this tree.
cd "$site"
npx --yes wrangler pages deploy . \
	--project-name="$project" \
	--branch="$branch" \
	--commit-hash="$sha" \
	--commit-message="$message"
