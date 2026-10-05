#!/usr/bin/env bash
# Bumps Casks/jet-pilot.rb in unxsist/homebrew-tap to a release.
# Usage: bump-homebrew-cask.sh <tag> [cask-file]
#   Without a cask file the tap is updated through the GitHub API
#   (GH_TOKEN needs write access to unxsist/homebrew-tap).
set -euo pipefail

tag="$1"
version="${tag#v}"
repo="${GITHUB_REPOSITORY:-unxsist/jet-pilot}"
tap="unxsist/homebrew-tap"
path="Casks/jet-pilot.rb"

# sha256 of a release asset: GitHub's digest, or download and hash it.
sha() {
  local name="JET.Pilot_${version}_$1" digest
  digest=$(gh release view "$tag" -R "$repo" --json assets \
    -q ".assets[] | select(.name == \"$name\") | .digest" | sed 's/^sha256://')
  if [[ ! "$digest" =~ ^[0-9a-f]{64}$ ]]; then
    gh release download "$tag" -R "$repo" -p "$name" -O - | sha256sum | cut -d' ' -f1
  else
    echo "$digest"
  fi
}

arm=$(sha aarch64.dmg)
intel=$(sha x64.dmg)
arm64_linux=$(sha aarch64.AppImage)
x86_64_linux=$(sha amd64.AppImage)
for value in "$arm" "$intel" "$arm64_linux" "$x86_64_linux"; do
  [[ "$value" =~ ^[0-9a-f]{64}$ ]] || { echo "Missing a release asset for $tag" >&2; exit 1; }
done

bump() {
  sed -E \
    -e "s/^(  version )\"[^\"]*\"/\1\"$version\"/" \
    -e "s/(\barm: +)\"[0-9a-f]{64}\"/\1\"$arm\"/" \
    -e "s/(\bintel: +)\"[0-9a-f]{64}\"/\1\"$intel\"/" \
    -e "s/(\barm64_linux: +)\"[0-9a-f]{64}\"/\1\"$arm64_linux\"/" \
    -e "s/(\bx86_64_linux: +)\"[0-9a-f]{64}\"/\1\"$x86_64_linux\"/"
}

if [[ $# -ge 2 ]]; then
  bump < "$2" > "$2.tmp" && mv "$2.tmp" "$2"
  exit 0
fi

current=$(gh api "repos/$tap/contents/$path")
blob=$(jq -r .sha <<< "$current")
updated=$(jq -r .content <<< "$current" | base64 -d | bump)
if [[ "$updated" == "$(jq -r .content <<< "$current" | base64 -d)" ]]; then
  echo "Cask already at $version"
  exit 0
fi
gh api -X PUT "repos/$tap/contents/$path" \
  -f message="jet-pilot $version" \
  -f content="$(base64 -w0 <<< "$updated")" \
  -f sha="$blob" > /dev/null
echo "Bumped $tap to jet-pilot $version"
