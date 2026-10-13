#!/bin/bash

# ─────────────────────────────────────────────────────────────────────────────
# OTA Build Script — incremental, one version per run
#
# v1 is the store build. Every OTA version ships a full bundle; patches are built
# only from earlier OTA versions (v2+), whose bundles are byte-identical on device.
# Clients on the store build download the full bundle once, then patch.
#
# Usage (npx react-native-bspatch ...):
#   patch [android|ios] [--flavor staging] [--release-version 1.0.4] [-y]
#                               → build + publish the next OTA (both platforms if omitted)
#   reset [--flavor ...] [--push] → wipe this release's OTAs
#   setup                       → wire OtaBundleResolver into AppDelegate / MainApplication
#   version <x.y.z>             → set the native app version (package.json, Gradle, Xcode)
# The release version is read from the native project and confirmed by a prompt (Enter keeps it).
# ─────────────────────────────────────────────────────────────────────────────

set -e
# Resolve symlinks: npx runs us via node_modules/.bin/react-native-bspatch
SOURCE="$0"
while [ -L "$SOURCE" ]; do
  LINK_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  case "$SOURCE" in /*) ;; *) SOURCE="$LINK_DIR/$SOURCE" ;; esac
done
SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
ROOT="$PWD"
BSDIFF="$SCRIPT_DIR/bsdiff"

if [ "$1" = "version" ]; then
  shift
  exec node "$SCRIPT_DIR/bump_version.js" "$@" --root "$ROOT"
fi

# ── Parameters ─────────────────────────────────────────────────────────────
FLAVOR="dev"
ACTION="ota"
PLATFORM_ARG=""
APP_VERSION_ARG=""
CONFIRM_VERSION=true

# Arg parsing
while [[ "$#" -gt 0 ]]; do
  case $1 in
    --platform) PLATFORM_ARG="$2"; shift ;;
    --flavor) FLAVOR="$2"; shift ;;
    --release-version|--app-version) APP_VERSION_ARG="$2"; shift ;;
    -y|--yes|--non-interactive) CONFIRM_VERSION=false ;;
    --push) PUSH_REMOTE=true ;;
    patch) ACTION="ota" ;;
    android|ios) PLATFORM_ARG="$1" ;;
    reset|setup) ACTION="$1" ;;
    base|seed|apk|ipa|--apk|--ipa|*.apk|*.aab|*.ipa)
      # Removed in 3.0: falling through would silently build and publish an OTA
      echo "❌ '$1' was removed: the first OTA after a store release is a full bundle, no base/seed needed."
      exit 1 ;;
    dev|staging|production) FLAVOR="$1" ;; # Support positional flavor
    *) echo "❌ Unknown argument: $1"; exit 1 ;;
  esac
  shift
done
# Configuration
FLAVOR_LOWER=$(echo "$FLAVOR" | tr '[:upper:]' '[:lower:]')
if [ "$FLAVOR_LOWER" = "dev" ]; then FLAVOR_LOWER="development"; fi
if [ "$FLAVOR_LOWER" = "prod" ]; then FLAVOR_LOWER="production"; fi

# ── Environment ──────────────────────────────────────────────────────────────
# .env.<flavor>: OTA_BASE_URL / OTA_FOLDER, the same values react-native-config bakes into the app.
# .env.ota: upload secrets (OTA_R2_*). Never put them in .env.<flavor>: react-native-config
# ships every key of that file inside the APK/IPA.
# Parsed like react-native-config (KEY=VALUE, optional quotes), never executed:
# `APP_NAME=Baseform Dev` is valid dotenv but breaks `source`.
load_env() {
  echo "Loading $(basename "$1")..."
  local line k v
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]] || continue
    k="${BASH_REMATCH[1]}"; v="${BASH_REMATCH[2]%$'\r'}"; v="${v#"${v%%[![:space:]]*}"}"
    if [[ "$v" =~ ^\"(.*)\"$ ]] || [[ "$v" =~ ^\'(.*)\'$ ]]; then v="${BASH_REMATCH[1]}"; fi
    export "$k=$v"
  done < "$1"
}
if [ "$ACTION" != "setup" ]; then
  if [ ! -f "$ROOT/.env.$FLAVOR_LOWER" ]; then
    echo "❌ $ROOT/.env.$FLAVOR_LOWER not found (OTA_BASE_URL / OTA_FOLDER for flavor '$FLAVOR_LOWER')"
    exit 1
  fi
  load_env "$ROOT/.env.$FLAVOR_LOWER"
  if [ -f "$ROOT/.env.ota" ]; then load_env "$ROOT/.env.ota"; fi
fi

# ── Setup (project wiring only, no build env needed) ─────────────────────────
if [ "$ACTION" = "setup" ]; then
  echo "Setting up react-native-bspatch in this project..."
  node "$SCRIPT_DIR/setup_project.js" --root "$ROOT"
  exit 0
fi

# ── Build environment ──────────────────────────────────────────────────────
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
# Reset syncs too: it edits the latest remote registry instead of overwriting it with a stale local copy
if [ "$ACTION" != "setup" ]; then
    echo "Syncing remote registry..."

    BASE_URL="${OTA_BASE_URL:-}"
    BASE_FOLDER="${OTA_FOLDER:-ota}"

    echo "  Using URL: $BASE_URL"
    echo "  Using Folder: $BASE_FOLDER"

    if [[ -n "${OTA_R2_BUCKET:-}" ]]; then
        R2_URL="https://${OTA_R2_ACCOUNT_ID:?set OTA_R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${OTA_R2_BUCKET}"
        r2() { curl -sS --aws-sigv4 "aws:amz:auto:s3" --user "${OTA_R2_ACCESS_KEY_ID:?}:${OTA_R2_SECRET_ACCESS_KEY:?}" "$@"; }
        # S3 API, not the public URL: always the latest object, no CDN cache
        API_HTTP=$(r2 -o "$REGISTRY_SHARED.tmp" -w "%{http_code}" "$R2_URL/$BASE_FOLDER/ota_registry.json" || echo 0)
    else
        if [[ "$BASE_URL" != "https://raw.githubusercontent.com/"* ]]; then
            echo "  ❌ Set OTA_R2_* (Cloudflare R2) or OTA_BASE_URL=https://raw.githubusercontent.com/<owner>/<repo>/<branch>"
            exit 1
        fi
        CLEAN_URL="${BASE_URL#https://raw.githubusercontent.com/}"
        GH_OWNER=$(echo "$CLEAN_URL" | cut -d'/' -f1)
        GH_REPO=$(echo  "$CLEAN_URL" | cut -d'/' -f2)
        GH_BRANCH=$(echo "$CLEAN_URL" | cut -d'/' -f3)
        if [[ -z "$GH_BRANCH" ]]; then GH_BRANCH="main"; fi

        # Contents API (not the raw CDN) always returns the latest commit; the raw
        # media type has no 1 MB limit and needs no base64 decoding.
        GH_API_TOKEN="$(gh auth token 2>/dev/null || true)"
        GH_API_TOKEN="${GH_API_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}"
        GH_API_AUTH=()
        if [[ -n "$GH_API_TOKEN" ]]; then GH_API_AUTH=(-H "Authorization: Bearer $GH_API_TOKEN"); fi

        API_HTTP=$(curl -s -o "$REGISTRY_SHARED.tmp" -w "%{http_code}" "${GH_API_AUTH[@]}" \
            -H "Accept: application/vnd.github.raw" \
            "https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${BASE_FOLDER}/ota_registry.json?ref=${GH_BRANCH}" || echo 0)
    fi

    if [[ "$API_HTTP" == "200" ]] && node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$REGISTRY_SHARED.tmp" 2>/dev/null; then
        mv "$REGISTRY_SHARED.tmp" "$REGISTRY_SHARED"
        echo "  ✓ Remote registry synced"
    elif [[ "$API_HTTP" == "404" ]]; then
        rm -f "$REGISTRY_SHARED.tmp"
        # Remote is the source of truth: a local registry from another storage would publish
        # entries for files that don't exist here
        echo '{"apps":{}}' > "$REGISTRY_SHARED"
        echo "  Notice: No remote registry yet (HTTP 404) — starting a new one."
    else
        # Continuing would later push a stale local registry over the remote one
        rm -f "$REGISTRY_SHARED.tmp"
        echo "  ❌ Registry sync failed (HTTP $API_HTTP). Check network / credentials and retry."
        exit 1
    fi
fi

# ── Helper: Download from remote storage ───────────────────────────────────────
download_remote() {
  local REMOTE_PATH="$1"
  local DEST="$2"
  local OK=0
  if [[ -n "${OTA_R2_BUCKET:-}" ]]; then
    r2 -f -o "$DEST.tmp" "$R2_URL/$REMOTE_PATH" 2>/dev/null || OK=1
  else
    # no-cache + timestamp query bypasses the GitHub CDN 5-min cache
    curl -s -f -H "Cache-Control: no-cache" -o "$DEST.tmp" "$BASE_URL/$REMOTE_PATH?cb=$(date +%s)" || OK=1
  fi
  if [ $OK -eq 0 ]; then
    mv "$DEST.tmp" "$DEST"
  else
    rm -f "$DEST.tmp"
    return 1
  fi
}

# ── Helper: compute SHA-256 hash ──────────────────────────────────────────────
sha256() {
  shasum -a 256 "$1" | awk '{print $1}'
}

# ── Progress helpers (exported: upload_ota.sh uses them too) ──────────────────
human_size() {
  awk -v b="$1" 'BEGIN { split("B KB MB GB", u); i = 1; while (b >= 1024 && i < 4) { b /= 1024; i++ }
    printf (i == 1 ? "%d %s" : "%.1f %s"), b, u[i] }'
}
file_size() { wc -c < "$1" | tr -d ' '; }
STEP=0
STEP_TOTAL=5
step() { STEP=$((STEP + 1)); STEP_START=$SECONDS; echo ""; echo "  [$STEP/$STEP_TOTAL] $*"; }
step_done() { echo "      ✓ $* ($((SECONDS - STEP_START))s)"; }
export -f human_size file_size

# ── Release version (native app version the OTA targets) ─────────────────────
android_version() {
  sed -nE "s/^[[:space:]]*versionName[[:space:]]+[\"']([^\"']+)[\"'].*/\1/p" "$ROOT/android/app/build.gradle" 2>/dev/null | head -n 1
}
ios_version() {
  grep -ho 'MARKETING_VERSION = [^;]*' "$ROOT"/ios/*.xcodeproj/project.pbxproj 2>/dev/null | head -n 1 | sed 's/.*= //'
}

if [ -n "$APP_VERSION_ARG" ]; then
  APP_VERSION="$APP_VERSION_ARG"
elif [ "$PLATFORM_ARG" = "android" ]; then
  APP_VERSION=$(android_version)
elif [ "$PLATFORM_ARG" = "ios" ]; then
  APP_VERSION=$(ios_version)
else
  AV=$(android_version); IV=$(ios_version)
  if [ -n "$AV" ] && [ -n "$IV" ] && [ "$AV" != "$IV" ]; then
    # One registry key per release version: publishing both under one would strand one platform
    echo "❌ Android is $AV but iOS is $IV. Run 'patch android' and 'patch ios' separately."
    exit 1
  fi
  APP_VERSION="${AV:-$IV}"
fi

# Confirm in a terminal (Enter keeps the detected version); CI / -y / --release-version skip it
if [ -t 0 ] && [ "$CONFIRM_VERSION" = true ] && [ -z "$APP_VERSION_ARG" ]; then
  echo ""
  read -r -p "  Release version for ${PLATFORM_ARG:-android + ios} [${APP_VERSION:-none detected}]: " INPUT_VERSION
  INPUT_VERSION="${INPUT_VERSION// /}"
  APP_VERSION="${INPUT_VERSION:-$APP_VERSION}"
fi

if [ -z "$APP_VERSION" ]; then
  echo "❌ Could not read the native app version. Pass --release-version <x.y.z>."
  exit 1
fi
echo "  ✓ Release version: $APP_VERSION"

# ── Reset ─────────────────────────────────────────────────────────────────────
if [ "$ACTION" = "reset" ]; then
  echo "Resetting OTA registry and output for flavor '$FLAVOR_LOWER'..."

  # Reset only the specific flavor in registry JSON if registry exists
  if [ -f "$REGISTRY_SHARED" ]; then
    node -e "
      try {
        const fs = require('fs');
        const reg = JSON.parse(fs.readFileSync('$REGISTRY_SHARED', 'utf8'));
        const flavors = reg.apps?.['$APP_VERSION']?.flavors;
        if (flavors?.['$FLAVOR_LOWER']) {
          // Keep the counter: reused numbers would make clients on an old vN skip the new vN,
          // and reused file names would serve stale cached bundles
          flavors['$FLAVOR_LOWER'] = { latestOtaVersion: flavors['$FLAVOR_LOWER'].latestOtaVersion || 1, patches: [] };
        }
        fs.writeFileSync('$REGISTRY_SHARED', JSON.stringify(reg, null, 4));
      } catch(e) {}
    "
  else
    echo '{"apps":{}}' > "$REGISTRY_SHARED"
  fi

  # Delete only this app version + flavor
  for D in "$ROOT/android/output" "$ROOT/ios/output"; do
    find "$D" -maxdepth 1 -type f -name "*_${APP_VERSION}_*" -name "*_${FLAVOR_LOWER}[._]*" -delete 2>/dev/null || true
    find "$D" -maxdepth 1 -type f -name "asset-manifest-v*_${FLAVOR_LOWER}.json" -delete 2>/dev/null || true # legacy names
  done

  echo "  ✓ Registry and output cleared for $APP_VERSION/$FLAVOR_LOWER "

  if [ "$PUSH_REMOTE" = true ]; then
      echo "  Syncing reset state for flavor '$FLAVOR_LOWER' to remote storage..."
      bash "$SCRIPT_DIR/upload_ota.sh" "$APP_VERSION" "$FLAVOR_LOWER" "0" "" "ios" "--clean-remote"
  fi
  exit 0
fi

# ── Ensure bsdiff compiled ───────────────────────────────────────────────────
if [ ! -f "$BSDIFF" ]; then
  echo "Compiling bsdiff..."
  clang -O2 -D BSDIFF_EXECUTABLE -o "$BSDIFF" "$SCRIPT_DIR/bsdiff.c" -lbz2
  echo "  ✓ bsdiff compiled"
fi

find_hermesc() {
  HERMESC_PATH="$ROOT/node_modules/hermes-compiler/hermesc/osx-bin/hermesc"
  if [ ! -f "$HERMESC_PATH" ]; then
      HERMESC_PATH="$ROOT/node_modules/react-native/sdks/hermesc/osx-bin/hermesc"
  fi
  if [ ! -f "$HERMESC_PATH" ]; then
      HERMESC_PATH="$ROOT/node_modules/hermes-compiler/hermesc/linux64-bin/hermesc"
  fi
  if [ ! -f "$HERMESC_PATH" ]; then
      HERMESC_PATH="$ROOT/node_modules/react-native/sdks/hermesc/linux64-bin/hermesc"
  fi
  if [ ! -f "$HERMESC_PATH" ]; then
      HERMESC_PATH="$(which hermesc 2>/dev/null || echo "")"
  fi
}

build_platform() {
  local PLATFORM="$1"
  local FLAVOR="$2"
  local CURRENT="$3"
  local NEXT="$4"
  local FLAVOR_LOWER=$(echo "$FLAVOR" | tr '[:upper:]' '[:lower:]')
  if [ "$FLAVOR_LOWER" = "dev" ]; then FLAVOR_LOWER="development"; fi
  if [ "$FLAVOR_LOWER" = "prod" ]; then FLAVOR_LOWER="production"; fi
  local FLAVOR_CAP=$(echo "$FLAVOR_LOWER" | perl -ne 'print ucfirst')

  local OUTPUT="$ROOT/android/output"
  if [ "$PLATFORM" == "ios" ]; then OUTPUT="$ROOT/ios/output"; fi
  local REGISTRY="$REGISTRY_SHARED"

  echo ""
  echo ">>> Building $PLATFORM | Version: $APP_VERSION | OTA: v$CURRENT → v$NEXT"
  STEP=0
  local PLATFORM_START=$SECONDS

  # ── Bundle ──
  # Workspace for building
  local WORKSPACE="$OUTPUT/workspace"
  mkdir -p "$WORKSPACE"

  # Determine source bundle
  local BUILD_LOG="$WORKSPACE/bundle.log"
  if [ "$PLATFORM" == "android" ]; then
    step "Bundling JS (Gradle createBundle${FLAVOR_CAP}ReleaseJsAndAssets)..."
    # Gradle's config noise goes to a log; shown only on failure
    if ! (cd "$ROOT/android" && ./gradlew ":app:createBundle${FLAVOR_CAP}ReleaseJsAndAssets" -Pkotlin.incremental=false --quiet) > "$BUILD_LOG" 2>&1; then
      tail -n 40 "$BUILD_LOG"; echo "  ❌ Gradle bundle failed (full log: $BUILD_LOG)"; exit 1
    fi
    BUNDLE_SOURCE="$ROOT/android/app/build/generated/assets/react/${FLAVOR_LOWER}Release/index.android.bundle"
  else
    step "Bundling JS (react-native bundle)..."
    if ! npx react-native bundle --platform ios --dev false --entry-file index.js \
      --bundle-output "$WORKSPACE/source.bundle" --assets-dest "$OUTPUT/assets" > "$BUILD_LOG" 2>&1; then
      tail -n 40 "$BUILD_LOG"; echo "  ❌ Bundle failed (full log: $BUILD_LOG)"; exit 1
    fi
    BUNDLE_SOURCE="$WORKSPACE/source.bundle"
  fi
  step_done "$(human_size "$(file_size "$BUNDLE_SOURCE")")"

  # Ensure Hermes bytecode format (for both iOS and Android OTA bundles)
  find_hermesc

  IS_HBC=false
  if [ -f "$BUNDLE_SOURCE" ]; then
    FIRST_BYTE=$(od -An -N1 -t x1 "$BUNDLE_SOURCE" | tr -d ' ' || echo "")
    if [ "$FIRST_BYTE" == "c6" ]; then IS_HBC=true; fi
  fi

  step "Hermes bytecode..."
  if [ "$IS_HBC" = true ]; then
    echo "      already Hermes bytecode"
  else
    if [ -z "$HERMESC_PATH" ] || [ ! -f "$HERMESC_PATH" ]; then
      echo "  ❌ ERROR: hermesc not found"; exit 1
    fi
    # -O matches what Xcode/Gradle use for release
    "$HERMESC_PATH" -emit-binary -O -out "$WORKSPACE/source.hbc" "$BUNDLE_SOURCE"
    mv "$WORKSPACE/source.hbc" "$BUNDLE_SOURCE"
  fi

  local BUNDLE_NAME="bundle_${APP_VERSION}_v${NEXT}_${PLATFORM}_${FLAVOR_LOWER}.hbc"
  local NEW_BUNDLE_PATH="$OUTPUT/$BUNDLE_NAME"

  cp "$BUNDLE_SOURCE" "$NEW_BUNDLE_PATH"
  step_done "$BUNDLE_NAME, $(human_size "$(file_size "$NEW_BUNDLE_PATH")")"

  # ── Assets ──
  local ASSET_MANIFEST_FILE="$OUTPUT/asset-manifest_${APP_VERSION}_v${NEXT}_${PLATFORM}_${FLAVOR_LOWER}.json"
  local ASSET_STORE_DIR="$OUTPUT/asset-store"
  mkdir -p "$ASSET_STORE_DIR"
  local ASSETS_SRC_DIR="$ROOT/android/app/build/generated/res/react/${FLAVOR_LOWER}Release"
  if [ "$PLATFORM" == "ios" ]; then ASSETS_SRC_DIR="$OUTPUT/assets"; fi

  local ASSET_JSON_LIST="["
  local FIRST=true
  local ASSET_COUNT=0
  step "Hashing assets..."
  if [ -d "$ASSETS_SRC_DIR" ]; then
    while IFS= read -r -d '' ASSET_FILE; do
      local HASH=$(sha256 "$ASSET_FILE")
      local FNAME=$(basename "$ASSET_FILE")
      local EX="${FNAME##*.}"
      # Capture relative path for resolver matching
      local REL_PATH="${ASSET_FILE#$ASSETS_SRC_DIR/}"
      # ponytail: every asset ships via the content-addressed store (clients download each hash once);
      # skipping assets already in the store binary needs a manifest of that binary
      cp "$ASSET_FILE" "$ASSET_STORE_DIR/${HASH}.${EX}"

      if [ "$FIRST" = true ]; then FIRST=false; else ASSET_JSON_LIST+=", "; fi
      ASSET_JSON_LIST+="{\"hash\": \"$HASH\", \"ext\": \"$EX\", \"originalPath\": \"$REL_PATH\"}"
      ASSET_COUNT=$((ASSET_COUNT + 1))
      if [ -t 1 ]; then printf "\r      %d assets" "$ASSET_COUNT"; fi
    done < <(find "$ASSETS_SRC_DIR" -type f -print0 2>/dev/null)
    if [ -t 1 ]; then printf "\r\033[K"; fi
  fi
  ASSET_JSON_LIST+="]"
  step_done "$ASSET_COUNT assets"

  cat > "$ASSET_MANIFEST_FILE" << EOF
{ "version": $NEXT, "appVersion": "$APP_VERSION", "platform": "$PLATFORM", "flavor": "$FLAVOR_LOWER", "assets": $ASSET_JSON_LIST }
EOF

  # ── Patches ──
  # From the last 5 OTA versions only (never v1 = store build). Clients on the
  # store build or further behind download the full bundle.
  local NEW_HASH=$(sha256 "$NEW_BUNDLE_PATH")
  local PATCHES_JSON="["
  local FIRST_FROM=$((NEXT - 5)); if [ $FIRST_FROM -lt 2 ]; then FIRST_FROM=2; fi
  local PATCH_TOTAL=$((NEXT - FIRST_FROM)) PATCH_N=0 PATCH_MADE=0
  if [ $PATCH_TOTAL -gt 0 ]; then
    step "Creating $PATCH_TOTAL patch(es) from v$FIRST_FROM..v$((NEXT - 1))..."
  else
    step "Patches: none (first OTA of this release — clients take the full bundle)"
  fi
  for (( i=FIRST_FROM; i<NEXT; i++ )); do
    PATCH_N=$((PATCH_N + 1))
    local OLD_B="bundle_${APP_VERSION}_v${i}_${PLATFORM}_${FLAVOR_LOWER}.hbc"
    local OLD_P="$OUTPUT/$OLD_B"
    if [ ! -f "$OLD_P" ]; then
      echo "      ($PATCH_N/$PATCH_TOTAL) v$i: downloading base bundle..."
      local REMOTE_BUNDLE_PATH="$BASE_FOLDER/$APP_VERSION/$FLAVOR_LOWER/$OLD_B"
      download_remote "$REMOTE_BUNDLE_PATH" "$OLD_P" || true
    fi
    if [ ! -f "$OLD_P" ]; then
      echo "      ($PATCH_N/$PATCH_TOTAL) v$i: ⚠ bundle not found, skipped (v$i clients take the full bundle)"
      continue
    fi
    local PNAME="patch_${APP_VERSION}_v${i}_to_v${NEXT}_${FLAVOR_LOWER}_${PLATFORM}.patch"
    local PATCH_START=$SECONDS
    if [ -t 1 ]; then printf "      (%d/%d) v%d → v%d ..." "$PATCH_N" "$PATCH_TOTAL" "$i" "$NEXT"; fi
    "$BSDIFF" "$OLD_P" "$NEW_BUNDLE_PATH" "$OUTPUT/$PNAME"
    if [ -t 1 ]; then printf "\r\033[K"; fi
    echo "      ($PATCH_N/$PATCH_TOTAL) v$i → v$NEXT: $(human_size "$(file_size "$OUTPUT/$PNAME")") ($((SECONDS - PATCH_START))s)"
    PATCH_MADE=$((PATCH_MADE + 1))
    if [ "$PATCHES_JSON" != "[" ]; then PATCHES_JSON+=", "; fi
    PATCHES_JSON+="{\"from\": $i, \"to\": $NEXT, \"file\": \"$PNAME\", \"baseHash\": \"$(sha256 "$OLD_P")\", \"bundleHash\": \"$NEW_HASH\"}"
  done
  PATCHES_JSON+="]"
  if [ $PATCH_TOTAL -gt 0 ]; then step_done "$PATCH_MADE patch(es)"; fi

  # ── Finalize ──
  step "Registry + upload..."
  node "$SCRIPT_DIR/update_registry.js" "$REGISTRY_SHARED" "$APP_VERSION" "$NEXT" "$PATCHES_JSON" "$PLATFORM" "$ASSET_MANIFEST_FILE" "$FLAVOR_LOWER"
  bash "$SCRIPT_DIR/upload_ota.sh" "$APP_VERSION" "$FLAVOR_LOWER" "$NEXT" "$NEW_BUNDLE_PATH" "$PLATFORM"
  echo ""
  echo "  ✓ $PLATFORM v$NEXT published in $((SECONDS - PLATFORM_START))s"
}

# ── Main ───────────────────────────────────────────────────────────────────
echo "=== OTA Build Pipeline | App: $APP_VERSION | Flavor: $FLAVOR ==="

FLAVOR_LOWER=$(echo "$FLAVOR" | tr '[:upper:]' '[:lower:]')
if [ "$FLAVOR_LOWER" = "dev" ]; then FLAVOR_LOWER="development"; fi
if [ "$FLAVOR_LOWER" = "prod" ]; then FLAVOR_LOWER="production"; fi

# Read current version once to coordinate across platforms
CURRENT_TOTAL=0
if [ -f "$REGISTRY_SHARED" ]; then
  CURRENT_TOTAL=$(node -e "
    try {
      const reg = JSON.parse(require('fs').readFileSync('$REGISTRY_SHARED','utf8'));
      console.log(reg.apps['$APP_VERSION']?.flavors?.['$FLAVOR_LOWER']?.latestOtaVersion || 0);
    } catch(e) { console.log(0); }
  ")
fi

# v1 is the store build: the first OTA build is v2
if [ "$CURRENT_TOTAL" -lt 1 ]; then CURRENT_TOTAL=1; fi
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




