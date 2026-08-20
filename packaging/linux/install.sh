#!/bin/sh
# Install the desktop entry and the icon set for a locally built rustermost.
#
# Why this exists: under Wayland a client cannot set its own window icon. The
# compositor takes the window's app_id (for us: the binary name, "rustermost"),
# looks for a matching .desktop file, and uses that file's Icon= line — so with
# nothing installed you get a generic placeholder in the task switcher and the
# panel. The .deb/.rpm/AppImage bundles install exactly these two things for
# you; this script does the same for `cargo tauri build` / `cargo tauri dev`.
#
# Usage: packaging/linux/install.sh [path-to-binary]
#   With no argument it looks for a release build, then a debug build, and
#   falls back to plain "rustermost" (i.e. expects it on your PATH).
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
icons="$repo/src-tauri/icons"
data="${XDG_DATA_HOME:-$HOME/.local/share}"

bin=${1:-}
if [ -z "$bin" ]; then
  for candidate in "$repo/src-tauri/target/release/rustermost" "$repo/src-tauri/target/debug/rustermost"; do
    if [ -x "$candidate" ]; then
      bin=$candidate
      break
    fi
  done
fi
[ -n "$bin" ] || bin=rustermost

# The icon name must match Icon= in the desktop entry, not the source filename.
for pair in 32x32.png:32x32 128x128.png:128x128 128x128@2x.png:256x256 icon.png:512x512; do
  src=${pair%%:*}
  size=${pair##*:}
  install -Dm644 "$icons/$src" "$data/icons/hicolor/$size/apps/rustermost.png"
done

# Exec must be runnable from the application menu, where PATH is minimal — so
# bake in the absolute path of the build we found.
sed "s|^Exec=.*|Exec=$bin|" "$here/rustermost.desktop" > "$data/applications/rustermost.desktop.tmp"
install -Dm644 "$data/applications/rustermost.desktop.tmp" "$data/applications/rustermost.desktop"
rm -f "$data/applications/rustermost.desktop.tmp"

# Refresh the caches so the entry shows up without logging out.
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$data/applications" || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "$data/icons/hicolor" >/dev/null 2>&1 || true
fi

echo "Installed:"
echo "  $data/applications/rustermost.desktop  (Exec=$bin)"
echo "  $data/icons/hicolor/{32x32,128x128,256x256,512x512}/apps/rustermost.png"
