#!/bin/bash
set -euo pipefail

# Run after package:dir. Never touch Pi sessions or application user data.
desktop_dir="$(cd "$(dirname "$0")/.." && pwd)"
bundle="$desktop_dir/release/mac-arm64/pi-gui.app"
installed=/Applications/pi-gui.app
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
test -x "$bundle/Contents/MacOS/pi-gui"
codesign --verify --deep --strict "$bundle"
osascript -e 'tell application id "com.pi-gui.desktop" to quit' || true
for attempt in {1..20}; do
  if ! pgrep -f '/pi-gui.app/Contents/MacOS/pi-gui' >/dev/null; then break; fi
  sleep 1
done
if pgrep -f '/pi-gui.app/Contents/MacOS/pi-gui' >/dev/null; then
  echo 'pi-gui is still running; close it normally and retry.' >&2
  exit 1
fi
archive="$HOME/.Trash/pi-gui-install-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$archive"
if [ -d "$installed" ]; then
  "$lsregister" -u "$installed" || true
  mv "$installed" "$archive/previous.app"
fi
ditto "$bundle" "$installed"
codesign --verify --deep --strict "$installed"
test -x "$installed/Contents/MacOS/pi-gui"
"$lsregister" -u "$bundle" || true
mv "$bundle" "$archive/build.app"
"$lsregister" -f "$installed"
killall Dock || true
open "$installed"
echo "Installed $installed; previous/generated bundles recoverable at $archive"
