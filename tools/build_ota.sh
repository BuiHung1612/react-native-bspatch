#!/bin/bash

# ─────────────────────────────────────────────────────────────────────────────
# OTA Build Script — incremental, one version per run
#
# Supports single-step updates (v1 -> v3 direct) and version grouping.
# Generates SHA-256 hashes for integrity verification.
#
# Usage:
#   ./build_ota.sh              → build next OTA version for current App.tsx
#   ./build_ota.sh base         → first build: create base APK/IPA + save base bundle
#   ./build_ota.sh reset        → wipe registry and start fresh
# ─────────────────────────────────────────────────────────────────────────────

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODULE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT="$PWD"
BUNDLE_XCODE_IOS="$ROOT/ios/output/main.jsbundle"
BSDIFF="$SCRIPT_DIR/bsdiff"
GENERATED_TS="$ROOT/src/ota/otaPatches.generated.ts"

# ── Load .env file if exists ─────────────────────────────────────────────────
# Look in project root first, then module directory (fallback)
ENV_FILE=""
if [ -f "$ROOT/.env" ]; then
    ENV_FILE="$ROOT/.env"
elif [ -f "$MODULE_DIR/.env" ]; then
    ENV_FILE="$MODULE_DIR/.env"
fi

if [ -n "$ENV_FILE" ]; then
    echo "Loading environment variables from $(basename "$ENV_FILE")..."
    export $(grep -v '^#' "$ENV_FILE" | grep -v '^$' | xargs)
    # Debug: verify loaded variables
    echo "  Loaded OTA_UPLOAD_USER=${OTA_UPLOAD_USER:+[SET]}"
    echo "  Loaded OTA_UPLOAD_PASSWORD=${OTA_UPLOAD_PASSWORD:+[SET]}"
else
    echo "  No .env file found in $ROOT or $MODULE_DIR"
fi

# ── Parameters ─────────────────────────────────────────────────────────────
FLAVOR="dev"
ACTION="ota"
PLATFORM_ARG=""

PUSH_REMOTE=false
# Arg parsing
while [[ "$#" -gt 0 ]]; do
  case $1 in
    --platform) PLATFORM_ARG="$2"; shift ;;
    --flavor) FLAVOR="$2"; shift ;;
    --push) PUSH_REMOTE=true ;;
    reset|base) ACTION="$1" ;;
    setup) ACTION="$1" ;;
    apk|ipa|seed) ACTION="base" ;; # Compatibility for legacy/seed actions
    dev|staging|production) FLAVOR="$1" ;; # Support positional flavor
    [0-9]*) ;; # Ignore version if passed as $1 (pos 1 usually)
  esac
  shift
done
# Configuration
FLAVOR_LOWER=$(echo "$FLAVOR" | tr '[:upper:]' '[:lower:]')

# ── Setup ──────────────────────────────────────────────────────────────────
echo "Preparing build environment..."
# Kill any existing Metro processes to prevent file locks
pkill -f "react-native/local-cli/cli.js" || true
pkill -f "metro-config/src/index.js" || true

# Manually clear metro cache if it exists (robust vs ENOTEMPTY error)
METRO_CACHE_DIR=$(node -e "console.log(require('os').tmpdir())")/metro-cache
if [ -d "$METRO_CACHE_DIR" ]; then
  echo "  Cleaning Metro cache..."
  rm -rf "$METRO_CACHE_DIR"
fi

mkdir -p "$ROOT/android/output"
mkdir -p "$ROOT/ios/output"
# Shared registry file for dual-platform builds
REGISTRY_SHARED="$ROOT/ota_registry.json"

# ── Registry Sync ──────────────────────────────────────────────────────────
# Skip registry sync for reset/clean actions
if [ "$ACTION" != "reset" ]; then
    echo "Syncing remote registry..."

    BASE_URL="${OTA_BASE_URL:-https://sync-server.osp.com.vn}"
    UPCODE_USER="${OTA_UPLOAD_USER:-}"
    UPCODE_PASS="${OTA_UPLOAD_PASSWORD:-}"
    BASE_FOLDER="${OTA_FOLDER:-ota}"

    echo "  Using URL: $BASE_URL"
    echo "  Using Folder: $BASE_FOLDER"

    if [[ "$BASE_URL" == *"github"* ]] || [[ "$BASE_URL" == *"raw.githubusercontent"* ]]; then
        echo "  Downloading remote registry from GitHub..."
        # Add cache-busting params + Cache-Control header to bypass GitHub CDN 5-min cache
        CACHE_BUST="?cb=$(date +%s)"
        HTTP_CODE=$(curl -s -w "%{http_code}" -H "Cache-Control: no-cache" -o "$REGISTRY_SHARED.tmp" "$BASE_URL/$BASE_FOLDER/ota_registry.json${CACHE_BUST}" 2>/dev/null || true)
        if [ "$HTTP_CODE" != "200" ]; then
            HTTP_CODE=$(curl -s -w "%{http_code}" -H "Cache-Control: no-cache" -o "$REGISTRY_SHARED.tmp" "$BASE_URL/ota_registry.json${CACHE_BUST}" 2>/dev/null || true)
        fi
        if [ "$HTTP_CODE" = "200" ] && [ -s "$REGISTRY_SHARED.tmp" ]; then
            mv "$REGISTRY_SHARED.tmp" "$REGISTRY_SHARED"
            echo "  ✓ Remote registry synced"
        else
            rm -f "$REGISTRY_SHARED.tmp"
            echo "  Notice: Remote registry not found on GitHub (starting fresh with local state)."
        fi
    else
        if [[ -n "$UPCODE_USER" ]] && [[ -n "$UPCODE_PASS" ]]; then
            LOGIN_RES=$(curl -s -X "POST" "$BASE_URL/public/authen/login" \
                 -H 'Content-Type: application/json; charset=utf-8' \
                 -w "\n---HTTP_STATUS:%{http_code}" \
                 -d "{\"username\": \"$UPCODE_USER\", \"password\": \"$UPCODE_PASS\"}")
            HTTP_STATUS=$(echo "$LOGIN_RES" | grep -o 'HTTP_STATUS:[0-9]*' | cut -d: -f2)
            LOGIN_BODY=$(echo "$LOGIN_RES" | sed 's/---HTTP_STATUS:.*//')

            TOKEN=$(echo "$LOGIN_BODY" | node -e "
                try {
                    const r = JSON.parse(require('fs').readFileSync(0, 'utf8'));
                    console.log(r.data?.accessTokenInfo?.accessToken || '');
                } catch(e) { console.log(''); }
            ")

            if [[ -n "$TOKEN" ]]; then
                REGISTRY_REMOTE_PATH="$BASE_FOLDER/ota_registry.json"
                ENCODED_PATH=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$REGISTRY_REMOTE_PATH', safe=''))")
                GEN_LINK_URL="$BASE_URL/api/minio/gen-download-link?pathFile=$ENCODED_PATH"
                LINK_RES=$(curl -s -X "GET" "$GEN_LINK_URL" -H "Authorization: Bearer $TOKEN")
                REGISTRY_URL=$(echo "$LINK_RES" | node -e "
                    try {
                        const r = JSON.parse(require('fs').readFileSync(0, 'utf8'));
                        console.log(r.data || '');
                    } catch(e) { console.log(''); }
                ")
                if [[ -n "$REGISTRY_URL" ]]; then
                    curl -s -o "$REGISTRY_SHARED" "$REGISTRY_URL"
                    echo "  ✓ Registry synced"
                fi
            else
                echo "  ⚠ MinIO login skipped. Proceeding with local state."
            fi
        else
            echo "  ⚠ No MinIO credentials. Proceeding with local state."
        fi
    fi
fi

# ── Helper: Download from Server ──────────────────────────────────────────────
download_from_minio() {
  local REMOTE_PATH="$1"
  local DEST="$2"
  local CB="?cb=$(date +%s)"

  if [[ "$BASE_URL" == *"github"* ]] || [[ "$BASE_URL" == *"raw.githubusercontent"* ]]; then
      # Use Cache-Control: no-cache + timestamp query to bypass GitHub CDN 5-min cache
      curl -s -f -H "Cache-Control: no-cache" -o "$DEST" "$BASE_URL/$REMOTE_PATH${CB}" 2>/dev/null || \
      curl -s -f -H "Cache-Control: no-cache" -o "$DEST" "$BASE_URL/$(basename "$REMOTE_PATH")${CB}" 2>/dev/null
      return $?
  fi

  if [[ -z "$TOKEN" ]]; then return 1; fi
  
  local ENCODED_PATH=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$REMOTE_PATH', safe=''))")
  local GEN_LINK_URL="$BASE_URL/api/minio/gen-download-link?pathFile=$ENCODED_PATH"
  local LINK_RES=$(curl -s -X "GET" "$GEN_LINK_URL" -H "Authorization: Bearer $TOKEN")
  local FILE_URL=$(echo "$LINK_RES" | node -e "
      try {
          const r = JSON.parse(require('fs').readFileSync(0, 'utf8'));
          console.log(r.data || '');
      } catch(e) { console.log(''); }
  ")
  if [[ -n "$FILE_URL" ]]; then
     # Use -f to return non-zero exit code on HTTP errors (like 404 Not Found)
     curl -s -f -o "$DEST" "$FILE_URL"
     if [ $? -eq 0 ]; then
       return 0
     fi
  fi
  return 1
}

# ── Helper: compute SHA-256 hash ──────────────────────────────────────────────
sha256() {
  shasum -a 256 "$1" | awk '{print $1}'
}

# ── Extract APP_VERSION from otaConfig.ts ─────────────────────────────────────
APP_VERSION=$(node -e "
  const fs = require('fs');
  const content = fs.readFileSync('$ROOT/src/ota/otaConfig.ts', 'utf8');
  const match = content.match(/export const APP_VERSION = ['\"](.+?)['\"]/);
  console.log(match ? match[1] : 'unknown');
")

if [ "$APP_VERSION" == "unknown" ]; then
  echo "ERROR: Could not find APP_VERSION in otaConfig.ts"
  exit 1
fi

# ── Reset ─────────────────────────────────────────────────────────────────────
if [ "$ACTION" = "reset" ]; then
  echo "Resetting OTA registry and clearing output..."
  echo '{"apps":{}}' > "$REGISTRY_SHARED"
  # Preserve base-assets manifests so the build after reset can still
  # correctly identify which assets are already bundled in the base app.
  # Only delete bundles, patches, manifests and workspace — not base-assets.
  find "$ROOT/android/output" -mindepth 1 -not -name 'base-assets_*' -delete 2>/dev/null || true
  find "$ROOT/ios/output" -mindepth 1 -not -name 'base-assets_*' -delete 2>/dev/null || true
  cat > "$GENERATED_TS" << 'TSEEOF'
// AUTO-GENERATED by build_ota.sh — do not edit manually
import type { OtaPatch } from 'react-native-bspatch';

export const OTA_PATCHES: OtaPatch[] = [];
TSEEOF
  echo "  ✓ Registry and output files cleared (base-assets preserved)"

  if [ "$PUSH_REMOTE" = true ]; then
      echo "  Syncing reset state to remote storage..."
      bash "$SCRIPT_DIR/upload_ota_custom.sh" "$APP_VERSION" "$FLAVOR_LOWER" "0" "" "ios" "--clean-remote"
  fi
  exit 0
fi

# ── Setup ─────────────────────────────────────────────────────────────────────
if [ "$ACTION" = "setup" ]; then
  echo "Setting up react-native-bspatch in this project..."
  node "$SCRIPT_DIR/setup_project.js" --root "$ROOT"
  exit 0
fi

# ── Ensure bsdiff compiled ───────────────────────────────────────────────────
if [ ! -f "$BSDIFF" ]; then
  echo "Compiling bsdiff..."
  clang -O2 -D BSDIFF_EXECUTABLE -o "$BSDIFF" "$SCRIPT_DIR/bsdiff.c" -lbz2
  echo "  ✓ bsdiff compiled"
fi

build_platform() {
  local PLATFORM="$1"
  local FLAVOR="$2"
  local CURRENT="$3"
  local NEXT="$4"
  local FLAVOR_CAP=$(echo "$FLAVOR" | perl -ne 'print ucfirst')
  local FLAVOR_LOWER=$(echo "$FLAVOR" | tr '[:upper:]' '[:lower:]')
  
  local OUTPUT="$ROOT/android/output"
  if [ "$PLATFORM" == "ios" ]; then OUTPUT="$ROOT/ios/output"; fi
  local REGISTRY="$REGISTRY_SHARED"

  echo ""
  echo ">>> Building $PLATFORM | Version: $APP_VERSION | OTA: v$CURRENT → v$NEXT"

  # ── Bundle ──
# ... (rest of the function omitted for space, but I'll make sure to replace correctly)

  # ── Bundle ──
  # Workspace for building
  local WORKSPACE="$OUTPUT/workspace"
  mkdir -p "$WORKSPACE"

  # Determine source bundle
  if [ "$PLATFORM" == "android" ]; then
    cd "$ROOT/android"
    ./gradlew ":app:createBundle${FLAVOR_CAP}ReleaseJsAndAssets" -Pkotlin.incremental=false --quiet
    cd "$ROOT"
    BUNDLE_SOURCE="$ROOT/android/app/build/generated/assets/react/${FLAVOR_LOWER}Release/index.android.bundle"
  else
    if [ -f "$BUNDLE_XCODE_IOS" ] && [ "$ACTION" = "base" ] && [ $CURRENT -eq 0 ]; then
      # Base action: use Xcode-compiled bundle (already Hermes-compiled, matches IPA exactly)
      echo "  Using Xcode bundle as base source..."
      cp "$BUNDLE_XCODE_IOS" "$WORKSPACE/source.bundle"
      # Also discover assets for base manifest
      echo "  Discovering assets from project (shadow bundle)..."
      npx react-native bundle --platform ios --dev false --entry-file index.js \
        --bundle-output "$WORKSPACE/shadow.bundle.tmp" --assets-dest "$OUTPUT/assets"
      rm -f "$WORKSPACE/shadow.bundle.tmp"
    else
      # OTA update: always generate fresh bundle from current code + discover assets
      echo "  Generating fresh iOS bundle from current code..."
      npx react-native bundle --platform ios --dev false --entry-file index.js \
        --bundle-output "$WORKSPACE/source.bundle" --assets-dest "$OUTPUT/assets"
    fi
    BUNDLE_SOURCE="$WORKSPACE/source.bundle"
  fi

  # Ensure Hermes bytecode format (for both iOS and Android OTA bundles)
  HERMESC_PATH="$ROOT/node_modules/hermes-compiler/hermesc/osx-bin/hermesc"
  if [ ! -f "$HERMESC_PATH" ]; then
      HERMESC_PATH="$ROOT/node_modules/react-native/sdks/hermesc/osx-bin/hermesc"
  fi

  IS_HBC=false
  if [ -f "$BUNDLE_SOURCE" ]; then
    FIRST_BYTE=$(od -An -N1 -t x1 "$BUNDLE_SOURCE" | tr -d ' ' || echo "")
    if [ "$FIRST_BYTE" == "c6" ]; then IS_HBC=true; fi
  fi

  if [ "$IS_HBC" = true ]; then
    echo "  Bundle is already in Hermes bytecode format."
  else
    echo "  Compiling to Hermes bytecode..."
    "$HERMESC_PATH" -emit-binary -out "$WORKSPACE/source.hbc" "$BUNDLE_SOURCE"
    mv "$WORKSPACE/source.hbc" "$BUNDLE_SOURCE"
  fi

  local BUNDLE_NAME="bundle_${APP_VERSION}_v${NEXT}_${PLATFORM}_${FLAVOR_LOWER}.hbc"
  local NEW_BUNDLE_PATH="$OUTPUT/$BUNDLE_NAME"

  if [ $CURRENT -eq 0 ] && [ "$ACTION" = "base" ] && [ "$PLATFORM" == "android" ]; then
    echo "Building base Release APK for $FLAVOR_CAP..."
    cd "$ROOT/android"
    ./gradlew "assemble${FLAVOR_CAP}Release" -Pkotlin.incremental=false --quiet
    cd "$ROOT"
    # Locate the APK dynamically as flavor names can vary in path
    APK_PATH=$(find "$ROOT/android/app/build/outputs/apk" -name "app-${FLAVOR_LOWER}-release.apk" | head -n 1)
    if [ -f "$APK_PATH" ]; then
      unzip -p "$APK_PATH" assets/index.android.bundle > "$NEW_BUNDLE_PATH"
    else
      echo "  ⚠ Warning: Could not find base APK at $APK_PATH. Using generated bundle directly."
      cp "$BUNDLE_SOURCE" "$NEW_BUNDLE_PATH"
    fi
  else
    cp "$BUNDLE_SOURCE" "$NEW_BUNDLE_PATH"
  fi

  # ── Assets ──
  local ASSET_MANIFEST_FILE="$OUTPUT/asset-manifest-v${NEXT}_${FLAVOR_LOWER}.json"
  local BASE_ASSET_MANIFEST="$OUTPUT/base-assets_${PLATFORM}_${FLAVOR_LOWER}.json"
  local ASSET_STORE_DIR="$OUTPUT/asset-store"
  mkdir -p "$ASSET_STORE_DIR"
  local ASSETS_SRC_DIR="$ROOT/android/app/build/generated/res/react/${FLAVOR_LOWER}Release"
  if [ "$PLATFORM" == "ios" ]; then ASSETS_SRC_DIR="$OUTPUT/assets"; fi

  # Load base assets — try server if missing locally (e.g. after ota:clean)
  if [ ! -f "$BASE_ASSET_MANIFEST" ] && [ -n "$TOKEN" ]; then
    local REMOTE_BASE_ASSET_PATH="$BASE_FOLDER/$APP_VERSION/$FLAVOR_LOWER/$(basename "$BASE_ASSET_MANIFEST")"
    echo "  Base asset manifest missing locally, downloading from server..."
    download_from_minio "$REMOTE_BASE_ASSET_PATH" "$BASE_ASSET_MANIFEST" || true
    if [ -f "$BASE_ASSET_MANIFEST" ]; then
      echo "  ✓ base-assets manifest restored from server"
    else
      echo "  ⚠ base-assets manifest not found on server — all assets will be treated as new"
    fi
  fi
  local BASE_ASSETS_JSON="{}"
  if [ -f "$BASE_ASSET_MANIFEST" ]; then
    BASE_ASSETS_JSON=$(cat "$BASE_ASSET_MANIFEST")
  fi

  local ASSET_JSON_LIST="["
  local FIRST=true
  local NEW_BASE_ASSETS="{"
  
  if [ -d "$ASSETS_SRC_DIR" ]; then
    while IFS= read -r -d '' ASSET_FILE; do
      local HASH=$(sha256 "$ASSET_FILE")
      local FNAME=$(basename "$ASSET_FILE")
      local EX="${FNAME##*.}"
      # Capture relative path for resolver matching
      local REL_PATH="${ASSET_FILE#$ASSETS_SRC_DIR/}"
      
      # Track for the new base manifest
      if [ "$NEW_BASE_ASSETS" != "{" ]; then NEW_BASE_ASSETS+=", "; fi
      NEW_BASE_ASSETS+="\"$REL_PATH\": \"$HASH\""

      # Optimization: Skip if hash matches the base APK version (client already has it)
      local IS_IN_BASE=$(node -e "
        try {
          const base = JSON.parse(require('fs').readFileSync('$BASE_ASSET_MANIFEST', 'utf8'));
          console.log(base['$REL_PATH'] === '$HASH' ? 'true' : 'false');
        } catch(e) { console.log('false'); }
      ")
      # Always add ALL assets to the manifest so the resolver can find them at runtime.
      # Only skip the file copy if the asset is unchanged from base (avoids redundant uploads).
      local ASSET_IS_BASE="false"
      if [ "$IS_IN_BASE" != "true" ] || [ "$ACTION" = "base" ]; then
        cp "$ASSET_FILE" "$ASSET_STORE_DIR/${HASH}.${EX}"
      else
        ASSET_IS_BASE="true"
      fi

      if [ "$FIRST" = true ]; then FIRST=false; else ASSET_JSON_LIST+=", "; fi
      ASSET_JSON_LIST+="{\"hash\": \"$HASH\", \"ext\": \"$EX\", \"originalPath\": \"$REL_PATH\", \"isBase\": $ASSET_IS_BASE}"
    done < <(find "$ASSETS_SRC_DIR" -type f -print0 2>/dev/null)
  fi
  ASSET_JSON_LIST+="]"
  NEW_BASE_ASSETS+="}"

  # If base action, save the manifest to local disk for future comparisons
  if [ "$ACTION" = "base" ]; then
    echo "$NEW_BASE_ASSETS" > "$BASE_ASSET_MANIFEST"
    echo "  ✓ Base asset manifest saved locally"
  fi

  cat > "$ASSET_MANIFEST_FILE" << EOF
{ "version": $NEXT, "appVersion": "$APP_VERSION", "platform": "$PLATFORM", "flavor": "$FLAVOR_LOWER", "assets": $ASSET_JSON_LIST }
EOF

  # ── Patches ──
  local PATCHES_JSON="[]"
  local NEW_HASH=$(sha256 "$NEW_BUNDLE_PATH")
  if [ $CURRENT -gt 0 ]; then
    PATCHES_JSON="["
    for (( i=1; i<$NEXT; i++ )); do
      local OLD_B="bundle_${APP_VERSION}_v${i}_${PLATFORM}_${FLAVOR_LOWER}.hbc"
      local OLD_P="$OUTPUT/$OLD_B"
      if [ ! -f "$OLD_P" ]; then 
        echo "  Missing local bundle for v$i. Attempting to download from server..."
        local REMOTE_BUNDLE_PATH="$BASE_FOLDER/$APP_VERSION/$FLAVOR_LOWER/$OLD_B"
        download_from_minio "$REMOTE_BUNDLE_PATH" "$OLD_P" || true
      fi
      if [ ! -f "$OLD_P" ]; then 
        echo "  ⚠ Warning: Could not find or download bundle v$i. Skipping patch generation from v$i."
        continue
      fi
      local PNAME="patch_${APP_VERSION}_v${i}_to_v${NEXT}_${FLAVOR_LOWER}_${PLATFORM}.patch"
      "$BSDIFF" "$OLD_P" "$NEW_BUNDLE_PATH" "$OUTPUT/$PNAME"
      if [ "$PATCHES_JSON" != "[" ]; then PATCHES_JSON+=", "; fi
      PATCHES_JSON+="{\"from\": $i, \"to\": $NEXT, \"file\": \"$PNAME\", \"baseHash\": \"$(sha256 "$OLD_P")\", \"bundleHash\": \"$NEW_HASH\"}"
    done
    PATCHES_JSON+="]"
  fi

  # ── Finalize ──
  node "$SCRIPT_DIR/update_registry.js" "$REGISTRY_SHARED" "$APP_VERSION" "$NEXT" "$PATCHES_JSON" "$PLATFORM" "$ASSET_MANIFEST_FILE" "$FLAVOR_LOWER"
  bash "$SCRIPT_DIR/upload_ota_custom.sh" "$APP_VERSION" "$FLAVOR_LOWER" "$NEXT" "$NEW_BUNDLE_PATH" "$PLATFORM"
}

# ── Main ───────────────────────────────────────────────────────────────────
echo "=== OTA Dual Build | App: $APP_VERSION | Flavor: $FLAVOR ==="

# Read current version once to coordinate across platforms
FLAVOR_LOWER=$(echo "$FLAVOR" | tr '[:upper:]' '[:lower:]')
CURRENT_TOTAL=0
if [ -f "$REGISTRY_SHARED" ]; then
  CURRENT_TOTAL=$(node -e "
    try {
      const reg = JSON.parse(require('fs').readFileSync('$REGISTRY_SHARED','utf8'));
      console.log(reg.apps['$APP_VERSION']?.flavors?.['$FLAVOR_LOWER']?.latestOtaVersion || 0);
    } catch(e) { console.log(0); }
  ")
fi
TARGET_OTA=$((CURRENT_TOTAL + 1))

if [ -n "$PLATFORM_ARG" ]; then
  build_platform "$PLATFORM_ARG" "$FLAVOR" "$CURRENT_TOTAL" "$TARGET_OTA"
else
  # Build both
  build_platform "android" "$FLAVOR" "$CURRENT_TOTAL" "$TARGET_OTA"
  build_platform "ios" "$FLAVOR" "$CURRENT_TOTAL" "$TARGET_OTA"
fi

echo ""
echo "=== All Builds Complete ==="





