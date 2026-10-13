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
    set -a; . "$ENV_FILE"; set +a
else
    echo "  No .env file found in $ROOT or $MODULE_DIR"
fi

# ── Parameters ─────────────────────────────────────────────────────────────
FLAVOR="dev"
ACTION="ota"
PLATFORM_ARG=""
APP_VERSION_ARG=""
NON_INTERACTIVE=false

SEED_APK=""
SEED_IPA=""
SEED_BUNDLE=""
FORCE_BASE=false

# Arg parsing
while [[ "$#" -gt 0 ]]; do
  case $1 in
    --platform) PLATFORM_ARG="$2"; shift ;;
    --flavor) FLAVOR="$2"; shift ;;
    --app-version) APP_VERSION_ARG="$2"; shift ;;
    --apk) SEED_APK="$2"; ACTION="seed"; shift ;;
    --ipa) SEED_IPA="$2"; ACTION="seed"; shift ;;
    --bundle) SEED_BUNDLE="$2"; ACTION="seed"; shift ;;
    --force) FORCE_BASE=true ;;
    -y|--yes|--non-interactive) NON_INTERACTIVE=true ;;
    --push) PUSH_REMOTE=true ;;
    reset|base) ACTION="$1" ;;
    setup) ACTION="$1" ;;
    seed) ACTION="seed" ;;
    apk|ipa) ACTION="base" ;; # Compatibility for legacy actions
    dev|staging|production) FLAVOR="$1" ;; # Support positional flavor
    [0-9]*) ;; # Ignore version if passed as $1 (pos 1 usually)
    *)
      if [[ "$1" == *.apk ]] || [[ "$1" == *.aab ]]; then
        SEED_APK="$1"
        ACTION="seed"
      elif [[ "$1" == *.ipa ]]; then
        SEED_IPA="$1"
        ACTION="seed"
      elif [[ "$1" == *.hbc ]] || [[ "$1" == *.bundle ]] || [[ "$1" == *.jsbundle ]]; then
        SEED_BUNDLE="$1"
        ACTION="seed"
      fi
      ;;
  esac
  shift
done
# Configuration
FLAVOR_LOWER=$(echo "$FLAVOR" | tr '[:upper:]' '[:lower:]')
if [ "$FLAVOR_LOWER" = "dev" ]; then FLAVOR_LOWER="development"; fi
if [ "$FLAVOR_LOWER" = "prod" ]; then FLAVOR_LOWER="production"; fi

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
# Reset syncs too: it edits the latest remote registry instead of overwriting it with a stale local copy
if [ "$ACTION" != "setup" ]; then
    echo "Syncing remote registry..."

    BASE_URL="${OTA_BASE_URL:-}"
    BASE_FOLDER="${OTA_FOLDER:-ota}"

    echo "  Using URL: $BASE_URL"
    echo "  Using Folder: $BASE_FOLDER"

    # GitHub is the only storage backend for now
    if [[ "$BASE_URL" != "https://raw.githubusercontent.com/"* ]]; then
        echo "  ❌ OTA_BASE_URL must be https://raw.githubusercontent.com/<owner>/<repo>/<branch>"
        exit 1
    fi
    echo "  Downloading remote registry from GitHub..."

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

    if [[ "$API_HTTP" == "200" ]] && node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$REGISTRY_SHARED.tmp" 2>/dev/null; then
        mv "$REGISTRY_SHARED.tmp" "$REGISTRY_SHARED"
        echo "  ✓ Remote registry synced (via GitHub API)"
    elif [[ "$API_HTTP" == "404" ]]; then
        rm -f "$REGISTRY_SHARED.tmp"
        echo "  Notice: No remote registry yet (HTTP 404) — starting fresh with local state."
    else
        # Continuing would later push a stale local registry over the remote one
        rm -f "$REGISTRY_SHARED.tmp"
        echo "  ❌ Registry sync failed (HTTP $API_HTTP). Check network / gh auth and retry."
        exit 1
    fi
fi

# ── Helper: Download from remote storage ───────────────────────────────────────
download_remote() {
  local REMOTE_PATH="$1"
  local DEST="$2"
  # no-cache + timestamp query bypasses the GitHub CDN 5-min cache
  if curl -s -f -H "Cache-Control: no-cache" -o "$DEST.tmp" "$BASE_URL/$REMOTE_PATH?cb=$(date +%s)"; then
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

# ── Auto-Detect APP_VERSION ──────────────────────────────────────────────────
APP_VERSION_INFO=$(node -e "
  const fs = require('fs');
  const path = require('path');
  const root = '$ROOT';
  const cliOverride = '$APP_VERSION_ARG';

  if (cliOverride && cliOverride !== '') {
    console.log(JSON.stringify({ version: cliOverride, source: 'CLI --app-version' }));
    process.exit(0);
  }

  // 1. Try android/app/build.gradle (most reliable for Android release)
  try {
    const gradlePath = path.join(root, 'android/app/build.gradle');
    if (fs.existsSync(gradlePath)) {
      const content = fs.readFileSync(gradlePath, 'utf8');
      const match = content.match(/versionName\\s+[\"']([^\"']+)[\"']/);
      if (match && match[1] !== '0.0.0' && match[1] !== '0.0.1') {
        console.log(JSON.stringify({ version: match[1], source: 'android/app/build.gradle' }));
        process.exit(0);
      }
    }
  } catch (e) {}

  // 2. Try ios project.pbxproj (most reliable for iOS release)
  try {
    const iosDir = path.join(root, 'ios');
    if (fs.existsSync(iosDir)) {
      const files = fs.readdirSync(iosDir);
      for (const f of files) {
        if (f.endsWith('.xcodeproj')) {
          const pbxPath = path.join(iosDir, f, 'project.pbxproj');
          if (fs.existsSync(pbxPath)) {
            const content = fs.readFileSync(pbxPath, 'utf8');
            const match = content.match(/MARKETING_VERSION\\s*=\\s*([^;]+);/);
            if (match && match[1].trim() !== '0.0.0' && match[1].trim() !== '0.0.1') {
              console.log(JSON.stringify({ version: match[1].trim(), source: 'ios/' + f }));
              process.exit(0);
            }
          }
        }
      }
    }
  } catch (e) {}

  // 3. Try package.json
  try {
    const pkgPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.version && pkg.version !== '0.0.0' && pkg.version !== '0.0.1') {
        console.log(JSON.stringify({ version: pkg.version, source: 'package.json' }));
        process.exit(0);
      }
    }
  } catch (e) {}

  // 4. Fallback: src/ota/otaConfig.ts
  try {
    const otaConfigPath = path.join(root, 'src/ota/otaConfig.ts');
    if (fs.existsSync(otaConfigPath)) {
      const content = fs.readFileSync(otaConfigPath, 'utf8');
      const match = content.match(/export const APP_VERSION = ['\"](.+?)['\"]/);
      if (match) {
        console.log(JSON.stringify({ version: match[1], source: 'src/ota/otaConfig.ts' }));
        process.exit(0);
      }
    }
  } catch (e) {}

  console.log(JSON.stringify({ version: 'unknown', source: 'none' }));
")

APP_VERSION=$(node -e "try { console.log(JSON.parse('$APP_VERSION_INFO').version); } catch(e) { console.log('unknown'); }")
APP_VERSION_SOURCE=$(node -e "try { console.log(JSON.parse('$APP_VERSION_INFO').source); } catch(e) { console.log('none'); }")

# Interactive confirmation / prompt:
# Prompt if running in an interactive terminal, not in reset mode, and no explicit flags passed
if [ -t 0 ] && [ -z "$APP_VERSION_ARG" ] && [ "$NON_INTERACTIVE" = false ] && [ "$ACTION" != "reset" ]; then
  echo ""
  echo "────────────────────────────────────────────────────────"
  if [ "$APP_VERSION" != "unknown" ]; then
    echo "  Detected Native App Version: $APP_VERSION ($APP_VERSION_SOURCE)"
    read -p "  Enter App Version to build [Press Enter for '$APP_VERSION']: " USER_INPUT_VER
  else
    read -p "  Enter Native App Version to build (e.g. 1.0.0): " USER_INPUT_VER
  fi
  echo "────────────────────────────────────────────────────────"
  echo ""

  if [ -n "$USER_INPUT_VER" ]; then
    APP_VERSION=$(echo "$USER_INPUT_VER" | tr -d ' ')
    APP_VERSION_SOURCE="User Input"
  fi
fi

if [ "$APP_VERSION" == "unknown" ] || [ -z "$APP_VERSION" ]; then
  echo "ERROR: Native App Version is required to build OTA updates."
  echo "       Please enter a valid version or use: ./build_ota.sh --app-version <version>"
  exit 1
fi

echo "  ✓ Building OTA for APP_VERSION=$APP_VERSION (Source: $APP_VERSION_SOURCE)"

# ── Reset ─────────────────────────────────────────────────────────────────────
if [ "$ACTION" = "reset" ]; then
  echo "Resetting OTA registry and output for flavor '$FLAVOR_LOWER'..."

  # Reset only the specific flavor in registry JSON if registry exists
  if [ -f "$REGISTRY_SHARED" ]; then
    node -e "
      try {
        const fs = require('fs');
        const reg = JSON.parse(fs.readFileSync('$REGISTRY_SHARED', 'utf8'));
        if (reg.apps && reg.apps['$APP_VERSION'] && reg.apps['$APP_VERSION'].flavors) {
          delete reg.apps['$APP_VERSION'].flavors['$FLAVOR_LOWER'];
        }
        fs.writeFileSync('$REGISTRY_SHARED', JSON.stringify(reg, null, 4));
      } catch(e) {}
    "
  else
    echo '{"apps":{}}' > "$REGISTRY_SHARED"
  fi

  # Delete only this app version + flavor. Base bundles (v1 = store binary) are kept:
  # the next build re-registers them automatically. Delete them by hand to re-seed.
  for D in "$ROOT/android/output" "$ROOT/ios/output"; do
    find "$D" -maxdepth 1 -type f -name "*_${APP_VERSION}_*" -name "*_${FLAVOR_LOWER}[._]*" \
      -not -name "bundle_${APP_VERSION}_v1_*" -delete 2>/dev/null || true
    find "$D" -maxdepth 1 -type f -name "asset-manifest-v*_${FLAVOR_LOWER}.json" -delete 2>/dev/null || true # legacy names
  done

  echo "  ✓ Registry and output cleared for $APP_VERSION/$FLAVOR_LOWER (base bundle v1 + base-assets kept)"

  if [ "$PUSH_REMOTE" = true ]; then
      echo "  Syncing reset state for flavor '$FLAVOR_LOWER' to remote storage..."
      bash "$SCRIPT_DIR/upload_ota.sh" "$APP_VERSION" "$FLAVOR_LOWER" "0" "" "ios" "--clean-remote"
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
  if [ "$PLATFORM" == "ios" ]; then
    local IOS_VER=$(grep -ho 'MARKETING_VERSION = [^;]*' "$ROOT"/ios/*.xcodeproj/project.pbxproj 2>/dev/null | head -n 1 | sed 's/.*= //')
    if [ -n "$IOS_VER" ] && [ "$IOS_VER" != "$APP_VERSION" ]; then
      echo "  ⚠ iOS MARKETING_VERSION is $IOS_VER but building for $APP_VERSION — iOS clients on $IOS_VER won't see this OTA"
    fi
  fi

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
    local XCODE_STALE=""
    if [ -f "$BUNDLE_XCODE_IOS" ]; then
      # ponytail: mtime check, any source edit/checkout after the last Xcode build marks it stale
      XCODE_STALE=$(find "$ROOT/src" "$ROOT/App.tsx" "$ROOT/index.js" "$ROOT/package.json" -type f -newer "$BUNDLE_XCODE_IOS" -print -quit 2>/dev/null)
      if [ -n "$XCODE_STALE" ] && [ "$ACTION" = "base" ]; then
        echo "  ⚠ Xcode bundle ($(stat -f '%Sm' "$BUNDLE_XCODE_IOS")) is older than $XCODE_STALE — ignoring it"
      fi
    fi
    if [ -f "$BUNDLE_XCODE_IOS" ] && [ -z "$XCODE_STALE" ] && [ "$ACTION" = "base" ] && [ $CURRENT -eq 0 ]; then
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
  find_hermesc

  IS_HBC=false
  if [ -f "$BUNDLE_SOURCE" ]; then
    FIRST_BYTE=$(od -An -N1 -t x1 "$BUNDLE_SOURCE" | tr -d ' ' || echo "")
    if [ "$FIRST_BYTE" == "c6" ]; then IS_HBC=true; fi
  fi

  if [ "$IS_HBC" = true ]; then
    echo "  Bundle is already in Hermes bytecode format."
  else
    echo "  Compiling to Hermes bytecode..."
    if [ -z "$HERMESC_PATH" ] || [ ! -f "$HERMESC_PATH" ]; then
      echo "  ❌ ERROR: hermesc not found"; exit 1
    fi
    # -O matches what Xcode/Gradle use for release, keeping patches against the store bundle small
    "$HERMESC_PATH" -emit-binary -O -out "$WORKSPACE/source.hbc" "$BUNDLE_SOURCE"
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
  local ASSET_MANIFEST_FILE="$OUTPUT/asset-manifest_${APP_VERSION}_v${NEXT}_${PLATFORM}_${FLAVOR_LOWER}.json"
  local BASE_ASSET_MANIFEST="$OUTPUT/base-assets_${PLATFORM}_${FLAVOR_LOWER}.json"
  local ASSET_STORE_DIR="$OUTPUT/asset-store"
  mkdir -p "$ASSET_STORE_DIR"
  local ASSETS_SRC_DIR="$ROOT/android/app/build/generated/res/react/${FLAVOR_LOWER}Release"
  if [ "$PLATFORM" == "ios" ]; then ASSETS_SRC_DIR="$OUTPUT/assets"; fi

  # Load base assets — try server if missing locally (e.g. after ota:clean)
  if [ ! -f "$BASE_ASSET_MANIFEST" ]; then
    local REMOTE_BASE_ASSET_PATH="$BASE_FOLDER/$APP_VERSION/$FLAVOR_LOWER/$(basename "$BASE_ASSET_MANIFEST")"
    echo "  Base asset manifest missing locally, downloading from server..."
    download_remote "$REMOTE_BASE_ASSET_PATH" "$BASE_ASSET_MANIFEST" || true
    if [ -f "$BASE_ASSET_MANIFEST" ]; then
      echo "  ✓ base-assets manifest restored from server"
    else
      echo "  ⚠ base-assets manifest not found on server — all assets will be treated as new"
    fi
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
      local IS_IN_BASE=false
      if [ -f "$BASE_ASSET_MANIFEST" ] && grep -qF "\"$REL_PATH\": \"$HASH\"" "$BASE_ASSET_MANIFEST"; then
        IS_IN_BASE=true
      fi
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
    # Patches from v1 (fresh store installs) + the last 5 versions. Older clients
    # fall back to the full bundle instead of bsdiff-ing every version each build.
    for (( i=1; i<$NEXT; i++ )); do
      if [ $i -gt 1 ] && [ $i -lt $((NEXT - 5)) ]; then continue; fi
      local OLD_B="bundle_${APP_VERSION}_v${i}_${PLATFORM}_${FLAVOR_LOWER}.hbc"
      local OLD_P="$OUTPUT/$OLD_B"
      if [ ! -f "$OLD_P" ]; then 
        echo "  Missing local bundle for v$i. Attempting to download from server..."
        local REMOTE_BUNDLE_PATH="$BASE_FOLDER/$APP_VERSION/$FLAVOR_LOWER/$OLD_B"
        download_remote "$REMOTE_BUNDLE_PATH" "$OLD_P" || true
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
  bash "$SCRIPT_DIR/upload_ota.sh" "$APP_VERSION" "$FLAVOR_LOWER" "$NEXT" "$NEW_BUNDLE_PATH" "$PLATFORM"
}

seed_platform() {
  local PLATFORM="$1"
  local FLAVOR="$2"
  local BINARY_PATH="$3"
  local FLAVOR_LOWER=$(echo "$FLAVOR" | tr '[:upper:]' '[:lower:]')
  if [ "$FLAVOR_LOWER" = "dev" ]; then FLAVOR_LOWER="development"; fi
  if [ "$FLAVOR_LOWER" = "prod" ]; then FLAVOR_LOWER="production"; fi

  local OUTPUT="$ROOT/android/output"
  if [ "$PLATFORM" == "ios" ]; then OUTPUT="$ROOT/ios/output"; fi
  mkdir -p "$OUTPUT"

  echo ""
  echo ">>> Seeding Base Bundle (v1) | Platform: $PLATFORM | App: $APP_VERSION | Flavor: $FLAVOR_LOWER"
  echo "  Source binary: $BINARY_PATH"

  if [ ! -f "$BINARY_PATH" ]; then
    echo "  ❌ ERROR: Source binary file not found: $BINARY_PATH"
    exit 1
  fi

  local TARGET_BUNDLE="$OUTPUT/bundle_${APP_VERSION}_v1_${PLATFORM}_${FLAVOR_LOWER}.hbc"
  local BASE_ASSET_MANIFEST="$OUTPUT/base-assets_${PLATFORM}_${FLAVOR_LOWER}.json"
  local ASSET_MANIFEST_FILE="$OUTPUT/asset-manifest_${APP_VERSION}_v1_${PLATFORM}_${FLAVOR_LOWER}.json"
  local TMP_DIR=$(mktemp -d)

  if [ "$PLATFORM" == "android" ]; then
    echo "  Extracting index.android.bundle from Android binary..."
    if unzip -l "$BINARY_PATH" 2>/dev/null | grep -q "assets/index.android.bundle"; then
      unzip -p "$BINARY_PATH" assets/index.android.bundle > "$TMP_DIR/extracted.bundle"
    elif unzip -l "$BINARY_PATH" 2>/dev/null | grep -q "base/assets/index.android.bundle"; then
      unzip -p "$BINARY_PATH" base/assets/index.android.bundle > "$TMP_DIR/extracted.bundle"
    elif [[ "$BINARY_PATH" == *.bundle ]] || [[ "$BINARY_PATH" == *.hbc ]]; then
      cp "$BINARY_PATH" "$TMP_DIR/extracted.bundle"
    else
      echo "  ❌ ERROR: Could not find 'assets/index.android.bundle' inside $BINARY_PATH"
      rm -rf "$TMP_DIR"
      exit 1
    fi
  else
    echo "  Extracting main.jsbundle from iOS binary..."
    local IPA_ENTRY=$(unzip -l "$BINARY_PATH" 2>/dev/null | grep -o 'Payload/[^/]*\.app/main\.jsbundle' | head -n 1)
    if [ -n "$IPA_ENTRY" ]; then
      unzip -p "$BINARY_PATH" "$IPA_ENTRY" > "$TMP_DIR/extracted.bundle"
    elif unzip -l "$BINARY_PATH" 2>/dev/null | grep -q "main.jsbundle"; then
      local ANY_BUNDLE=$(unzip -l "$BINARY_PATH" 2>/dev/null | grep -o '[^ ]*main\.jsbundle' | head -n 1)
      unzip -p "$BINARY_PATH" "$ANY_BUNDLE" > "$TMP_DIR/extracted.bundle"
    elif [[ "$BINARY_PATH" == *.bundle ]] || [[ "$BINARY_PATH" == *.hbc ]] || [[ "$BINARY_PATH" == *.jsbundle ]]; then
      cp "$BINARY_PATH" "$TMP_DIR/extracted.bundle"
    else
      echo "  ❌ ERROR: Could not find 'main.jsbundle' inside $BINARY_PATH"
      rm -rf "$TMP_DIR"
      exit 1
    fi
  fi

  # Check Hermes bytecode format (0xc6 magic number)
  FIRST_BYTE=$(od -An -N1 -t x1 "$TMP_DIR/extracted.bundle" | tr -d ' ' || echo "")
  if [ "$FIRST_BYTE" == "c6" ]; then
    echo "  ✓ Bundle is verified Hermes bytecode format."
    cp "$TMP_DIR/extracted.bundle" "$TARGET_BUNDLE"
  else
    echo "  Bundle is JavaScript text. Compiling to Hermes bytecode..."
    find_hermesc
    if [ -z "$HERMESC_PATH" ] || [ ! -f "$HERMESC_PATH" ]; then
      echo "  ❌ ERROR: hermesc compiler not found. Cannot compile bundle to bytecode."
      rm -rf "$TMP_DIR"
      exit 1
    fi
    "$HERMESC_PATH" -emit-binary -O -out "$TARGET_BUNDLE" "$TMP_DIR/extracted.bundle"
  fi

  # Extract base assets manifest
  echo "  Scanning assets from binary for base manifest..."
  local NEW_BASE_ASSETS="{"
  local ASSET_JSON_LIST="["
  local FIRST=true

  if [ "$PLATFORM" == "android" ]; then
    unzip -q -o "$BINARY_PATH" "res/drawable*/*" "res/raw/*" "base/res/drawable*/*" "base/res/raw/*" -d "$TMP_DIR/assets_unzipped" 2>/dev/null || true
  else
    unzip -q -o "$BINARY_PATH" "Payload/*.app/assets/*" -d "$TMP_DIR/assets_unzipped" 2>/dev/null || true
  fi

  if [ -d "$TMP_DIR/assets_unzipped" ]; then
    while IFS= read -r -d '' ASSET_FILE; do
      local HASH=$(sha256 "$ASSET_FILE")
      local FNAME=$(basename "$ASSET_FILE")
      local EX="${FNAME##*.}"
      local REL_PATH="${ASSET_FILE#$TMP_DIR/assets_unzipped/}"
      # Same keys as build_platform: iOS "assets/...", Android "drawable-*/..." / "raw/..."
      REL_PATH=$(echo "$REL_PATH" | sed -E 's#^Payload/[^/]+\.app/##; s#^(base/)?res/##')

      if [ "$NEW_BASE_ASSETS" != "{" ]; then NEW_BASE_ASSETS+=", "; fi
      NEW_BASE_ASSETS+="\"$REL_PATH\": \"$HASH\""

      if [ "$FIRST" = true ]; then FIRST=false; else ASSET_JSON_LIST+=", "; fi
      ASSET_JSON_LIST+="{\"hash\": \"$HASH\", \"ext\": \"$EX\", \"originalPath\": \"$REL_PATH\", \"isBase\": true}"
    done < <(find "$TMP_DIR/assets_unzipped" -type f -print0 2>/dev/null)
  fi

  NEW_BASE_ASSETS+="}"
  ASSET_JSON_LIST+="]"

  echo "$NEW_BASE_ASSETS" > "$BASE_ASSET_MANIFEST"
  cat > "$ASSET_MANIFEST_FILE" << EOF
{ "version": 1, "appVersion": "$APP_VERSION", "platform": "$PLATFORM", "flavor": "$FLAVOR_LOWER", "assets": $ASSET_JSON_LIST }
EOF

  rm -rf "$TMP_DIR"

  local BUNDLE_HASH=$(sha256 "$TARGET_BUNDLE")
  echo "  ✓ Base bundle v1 successfully created: $(basename "$TARGET_BUNDLE")"
  echo "    SHA-256: $BUNDLE_HASH"

  # Update registry for v1
  node "$SCRIPT_DIR/update_registry.js" "$REGISTRY_SHARED" "$APP_VERSION" "1" "[]" "$PLATFORM" "$ASSET_MANIFEST_FILE" "$FLAVOR_LOWER"

  # Push if requested
  if [ "$PUSH_REMOTE" = true ]; then
    echo "  Pushing seeded base bundle to remote..."
    bash "$SCRIPT_DIR/upload_ota.sh" "$APP_VERSION" "$FLAVOR_LOWER" "1" "$TARGET_BUNDLE" "$PLATFORM"
  fi

  echo "  ✓ Seeding complete for $PLATFORM!"
}

# ── Main ───────────────────────────────────────────────────────────────────
echo "=== OTA Build Pipeline | App: $APP_VERSION | Flavor: $FLAVOR ==="

FLAVOR_LOWER=$(echo "$FLAVOR" | tr '[:upper:]' '[:lower:]')
if [ "$FLAVOR_LOWER" = "dev" ]; then FLAVOR_LOWER="development"; fi
if [ "$FLAVOR_LOWER" = "prod" ]; then FLAVOR_LOWER="production"; fi

# ── Seed Action ────────────────────────────────────────────────────────────
if [ "$ACTION" = "seed" ]; then
  if [ -n "$SEED_APK" ]; then
    seed_platform "android" "$FLAVOR_LOWER" "$SEED_APK"
  elif [ -n "$SEED_IPA" ]; then
    seed_platform "ios" "$FLAVOR_LOWER" "$SEED_IPA"
  elif [ -n "$SEED_BUNDLE" ]; then
    PLATFORM="${PLATFORM_ARG:-android}"
    seed_platform "$PLATFORM" "$FLAVOR_LOWER" "$SEED_BUNDLE"
  else
    echo "❌ Please provide a binary file to seed:"
    echo "   ./build_ota.sh seed --apk <path-to-apk>"
    echo "   ./build_ota.sh seed --ipa <path-to-ipa>"
    exit 1
  fi
  echo ""
  echo "=== Base Seeding Complete ==="
  exit 0
fi

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

# ── Fail-Safe Guard for OTA Updates ────────────────────────────────────────
# If building an OTA patch but no base version (v1) exists in the registry:
if [ "$ACTION" = "ota" ] && [ $CURRENT_TOTAL -eq 0 ]; then
  echo "Checking for pre-existing Base Bundle v1..."
  
  CHECK_PLATFORMS=()
  if [ -n "$PLATFORM_ARG" ]; then
    CHECK_PLATFORMS=("$PLATFORM_ARG")
  else
    CHECK_PLATFORMS=("android" "ios")
  fi

  ALL_FOUND=true
  MISSING_PLATFORM=""
  for P in "${CHECK_PLATFORMS[@]}"; do
    P_OUTPUT="$ROOT/$P/output"
    P_BASE_BUNDLE="$P_OUTPUT/bundle_${APP_VERSION}_v1_${P}_${FLAVOR_LOWER}.hbc"
    
    # Check if local exists
    if [ ! -f "$P_BASE_BUNDLE" ]; then
      # Try downloading from remote if available
      REMOTE_BASE_PATH="$BASE_FOLDER/$APP_VERSION/$FLAVOR_LOWER/$(basename "$P_BASE_BUNDLE")"
      download_remote "$REMOTE_BASE_PATH" "$P_BASE_BUNDLE" || true
    fi

    if [ -f "$P_BASE_BUNDLE" ]; then
      echo "  ✓ Found Base Bundle v1 for $P: $(basename "$P_BASE_BUNDLE")"
      # Auto-adopt base bundle in registry
      node "$SCRIPT_DIR/update_registry.js" "$REGISTRY_SHARED" "$APP_VERSION" "1" "[]" "$P" "" "$FLAVOR_LOWER"
    else
      ALL_FOUND=false
      MISSING_PLATFORM="$P"
    fi
  done

  if [ "$ALL_FOUND" = true ]; then
    echo "  ✓ Base bundle v1 verified and registered. Proceeding with incremental OTA update..."
    CURRENT_TOTAL=1
  else
    if [ "$FORCE_BASE" = true ]; then
      echo "  ⚠ Warning: --force flag detected. Creating base bundle v1 from current working tree..."
      ACTION="base"
    else
      echo ""
      echo "╔══════════════════════════════════════════════════════════════════════════════════════════╗"
      echo "║ ❌ CANNOT BUILD OTA: MISSING BASE BUNDLE (v1)                                            ║"
      echo "╠══════════════════════════════════════════════════════════════════════════════════════════╣"
      echo "║ App Version: $APP_VERSION | Flavor: $FLAVOR_LOWER | Missing: $MISSING_PLATFORM"
      echo "║"
      echo "║ No base bundle (v1) was found for this app version (neither locally nor on remote).     ║"
      echo "║ If an OTA update is built now, it would generate a base bundle from your current         ║"
      echo "║ working tree, which will MISMATCH the version installed on user devices and force a      ║"
      echo "║ 100% full-bundle download (wasting bandwidth and bypassing patch benefits).              ║"
      echo "║"
      echo "║ How to resolve:                                                                          ║"
      echo "║ 1. If you already have the release APK/IPA submitted to Google Play / App Store:         ║"
      echo "║    Seed the exact base bundle from your release binary:                                  ║"
      echo "║      ./build_ota.sh seed --apk <path-to-apk>                                             ║"
      echo "║      ./build_ota.sh seed --ipa <path-to-ipa>                                             ║"
      echo "║"
      echo "║ 2. If you are preparing a brand new Store release right now from this commit:            ║"
      echo "║      ./build_ota.sh base                                                                 ║"
      echo "║"
      echo "║ 3. If you really want to force create base v1 from current code:                         ║"
      echo "║      ./build_ota.sh --force                                                              ║"
      echo "╚══════════════════════════════════════════════════════════════════════════════════════════╝"
      echo ""
      exit 1
    fi
  fi
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




