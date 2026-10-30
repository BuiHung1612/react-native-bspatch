#!/bin/sh
# Xcode build phase step (wired by `react-native-bspatch setup`, run through RN's
# with-environment.sh so NODE_BINARY is set): stamps the native runtime fingerprint
# into the .app. An OTA only installs on a binary with the same fingerprint.
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
FP=$("$NODE_BINARY" "$DIR/fingerprint.js" "$SRCROOT/.." ios)
echo "$FP" > "$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/bspatch_fingerprint.txt"
echo "react-native-bspatch: runtime fingerprint $FP"
