#!/bin/bash

# ─────────────────────────────────────────────────────────────────────────────
# Custom OTA Upload Script for Sync Server & GitHub Storage
# Uploads:  1) All .patch & .hbc files  →  {baseFolder}/{appVersion}/{channel}/
#           2) ota_registry.json         →  {baseFolder}/ota_registry.json
# ─────────────────────────────────────────────────────────────────────────────

# Load environment variables if .env exists
ROOT_DIR=$(pwd)
if [ -f "$ROOT_DIR/.env" ]; then
    export $(grep -v '^#' "$ROOT_DIR/.env" | grep -v '^$' | xargs 2>/dev/null)
fi

BASE_URL="${OTA_BASE_URL:-}"
UPCODE_USER="${OTA_UPLOAD_USER:-}"
UPCODE_PASS="${OTA_UPLOAD_PASSWORD:-}"
BASE_FOLDER="${OTA_FOLDER:-${6:-ota}}"
APP_VERSION="$1"
CHANNEL="$2"
OTA_VERSION="$3"
BUNDLE_PATH="$4"  # unused — we upload .patch files, not the bundle
PLATFORM="$5"

REGISTRY_FILE="$ROOT_DIR/ota_registry.json"
OUTPUT_DIR="$ROOT_DIR/android/output"
if [[ "$PLATFORM" == "ios" ]]; then
    OUTPUT_DIR="$ROOT_DIR/ios/output"
fi

echo ""
echo "=== Custom OTA Upload | App: $APP_VERSION | Channel: $CHANNEL | V$OTA_VERSION | Platform: $PLATFORM ==="
echo "  Output dir: $OUTPUT_DIR"

# Validate
if [[ -z "$APP_VERSION" || -z "$OTA_VERSION" ]]; then
    echo "Usage: $0 <app_version> <channel> <ota_version> <bundle_path> [platform] [base_folder]"
    exit 1
fi
if [[ ! -f "$REGISTRY_FILE" ]]; then
    echo "ERROR: ota_registry.json not found: $REGISTRY_FILE"
    exit 1
fi

# Check for clean remote flag
CLEAN_REMOTE=false
for ARG in "$@"; do
    if [ "$ARG" == "--clean-remote" ]; then
        CLEAN_REMOTE=true
    fi
done

# ── GitHub Auto-Push Integration ──────────────────────────────────────────────
if [[ "$BASE_URL" == *"github"* ]] || [[ "$BASE_URL" == *"raw.githubusercontent"* ]]; then
    # Parse OWNER, REPO, BRANCH from URL
    # Example: https://raw.githubusercontent.com/hungbv-taureau/baseform-storage/main
    CLEAN_URL=$(echo "$BASE_URL" | sed 's#https://raw.githubusercontent.com/##' | sed 's#https://github.com/##')
    OWNER=$(echo "$CLEAN_URL" | cut -d'/' -f1)
    REPO=$(echo "$CLEAN_URL" | cut -d'/' -f2)
    BRANCH=$(echo "$CLEAN_URL" | cut -d'/' -f3)
    if [[ -z "$BRANCH" ]]; then BRANCH="main"; fi

    # Check for gh token or env tokens
    GH_CLI_TOKEN=$(gh auth token 2>/dev/null || true)
    TOKEN="${GH_CLI_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}"
    if [[ "$TOKEN" == "baseform" ]]; then TOKEN=""; fi

    if [[ -n "$TOKEN" ]]; then
        GIT_REMOTE="https://x-access-token:${TOKEN}@github.com/${OWNER}/${REPO}.git"
        echo "  Using authenticated gh CLI token for ${OWNER}/${REPO}"
    else
        GIT_REMOTE="git@github.com:${OWNER}/${REPO}.git"
    fi

    GH_REPO_DIR="/tmp/ota_git_repo_${REPO}"

    echo ""
    echo "=== Auto Syncing OTA Release to GitHub Storage ==="
    echo "  Target Repo : ${OWNER}/${REPO}"
    echo "  Branch      : ${BRANCH}"
    
    # 1. Clone or Pull target storage repo
    if [ -d "$GH_REPO_DIR/.git" ]; then
        echo "  Syncing local storage clone with remote..."
        git -C "$GH_REPO_DIR" remote set-url origin "$GIT_REMOTE" 2>/dev/null || true
        git -C "$GH_REPO_DIR" fetch origin "$BRANCH" 2>/dev/null || true
        git -C "$GH_REPO_DIR" checkout "$BRANCH" 2>/dev/null || true
        git -C "$GH_REPO_DIR" reset --hard "origin/$BRANCH" 2>/dev/null || true
    else
        echo "  Cloning storage repository..."
        rm -rf "$GH_REPO_DIR"
        git clone --branch "$BRANCH" --depth 1 "$GIT_REMOTE" "$GH_REPO_DIR" 2>/dev/null || git clone "$GIT_REMOTE" "$GH_REPO_DIR"
    fi

    # 2. Copy generated files into storage repo (or reset remote)
    if [ "$CLEAN_REMOTE" = true ]; then
        echo "  Resetting remote storage state..."
        rm -rf "$GH_REPO_DIR/$BASE_FOLDER/$APP_VERSION"
        mkdir -p "$GH_REPO_DIR/$BASE_FOLDER"
        cp "$REGISTRY_FILE" "$GH_REPO_DIR/$BASE_FOLDER/ota_registry.json"
        cp "$REGISTRY_FILE" "$GH_REPO_DIR/ota_registry.json" 2>/dev/null || true
    else
        TARGET_RELEASE_DIR="$GH_REPO_DIR/$BASE_FOLDER/$APP_VERSION/$CHANNEL"
        mkdir -p "$TARGET_RELEASE_DIR"
        
        echo "  Copying release files to storage repo..."
        for FILE in "$OUTPUT_DIR"/*.{patch,hbc,json}; do
            [[ -f "$FILE" ]] || continue
            FNAME=$(basename "$FILE")
            cp "$FILE" "$TARGET_RELEASE_DIR/$FNAME"
        done

        # Copy asset store if present
        if [[ -d "$OUTPUT_DIR/asset-store" ]]; then
            TARGET_ASSET_DIR="$GH_REPO_DIR/$BASE_FOLDER/assets"
            mkdir -p "$TARGET_ASSET_DIR"
            cp -R "$OUTPUT_DIR/asset-store/"* "$TARGET_ASSET_DIR/" 2>/dev/null || true
        fi

        # Copy ota_registry.json
        mkdir -p "$GH_REPO_DIR/$BASE_FOLDER"
        cp "$REGISTRY_FILE" "$GH_REPO_DIR/$BASE_FOLDER/ota_registry.json"
        cp "$REGISTRY_FILE" "$GH_REPO_DIR/ota_registry.json" 2>/dev/null || true
    fi

    # 3. Commit and Push to GitHub
    cd "$GH_REPO_DIR"
    git config user.name "hungbv-taureau" 2>/dev/null || true
    git config user.email "hungbv@taureau.ai" 2>/dev/null || true
    git add .
    if git diff --staged --quiet; then
        echo "  ✓ Storage repository is up to date (no changes)."
    else
        COMMIT_MSG="auto(ota): publish $PLATFORM $APP_VERSION v$OTA_VERSION ($CHANNEL)"
        if [ "$CLEAN_REMOTE" = true ]; then
            COMMIT_MSG="auto(ota): reset remote OTA registry and releases"
        fi
        echo "  Committing OTA changes ($COMMIT_MSG)..."
        git commit -m "$COMMIT_MSG"
        echo "  Pushing to GitHub (${BRANCH})..."
        
        if git push origin "$BRANCH"; then
            echo "  ✓ Successfully pushed OTA release to GitHub!"
        else
            echo "  ⚠ Git push failed. Please verify write permissions for ${OWNER}/${REPO}."
        fi
    fi
    cd "$ROOT_DIR"
    echo ""
    echo "=== GitHub Sync Complete ==="
    exit 0
fi

# ── MinIO Server Integration ──────────────────────────────────────────────────
echo "Logging in to MinIO Server..."
LOGIN_RES=$(curl -s -X "POST" "$BASE_URL/public/authen/login" \
     -H 'Content-Type: application/json; charset=utf-8' \
     -d "{\"username\": \"$UPCODE_USER\", \"password\": \"$UPCODE_PASS\"}")

TOKEN=$(echo "$LOGIN_RES" | node -e "
    try {
        const r = JSON.parse(require('fs').readFileSync(0, 'utf8'));
        console.log(r.data?.accessTokenInfo?.accessToken || '');
    } catch(e) { console.log(''); }
")
if [[ -z "$TOKEN" ]]; then
    echo "  ⚠ Notice: Remote MinIO server login skipped."
    echo "  ✓ Bundles & registry generated at: $OUTPUT_DIR"
    echo "  Please commit and push local changes to your GitHub storage repository."
    exit 0
fi
echo "  ✓ Login successful"

remote_delete() {
    local path=$1
    local encoded
    encoded=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$path'))")
    curl -s -X "DELETE" "$BASE_URL/api/minio/delete?path=$encoded" \
         -H "Authorization: Bearer $TOKEN" > /dev/null
}

remote_upload() {
    local local_file=$1
    local remote_path=$2
    echo "  uploading: $remote_path"
    local RES
    RES=$(curl -s -X "POST" "$BASE_URL/api/minio/upload" \
        -H "Authorization: Bearer $TOKEN" \
        -H 'Content-Type: multipart/form-data' \
        -F "file=@$local_file" \
        -F "path=$remote_path")
    if [[ "$RES" != *"\"success\":true"* ]] && [[ "$RES" != *"\"code\":1"* ]] && [[ "$RES" != *"\"status\":200"* ]] && [[ "$RES" != *"\"code\":200"* ]]; then
        echo "    ⚠ Upload potential issue: $RES"
    else
        echo "    ✓ Upload success"
    fi
}

echo "Uploading files for channel: $CHANNEL..."
FILE_COUNT=0
for FILE in "$OUTPUT_DIR"/*.{patch,hbc,json}; do
    [[ -f "$FILE" ]] || continue
    FNAME=$(basename "$FILE")
    if [[ "$FNAME" == "patch_"* ]] || [[ "$FNAME" == "bundle_"* ]]; then
        if [[ "$FNAME" != *"_${APP_VERSION}_"* ]]; then
            continue
        fi
    fi

    if [[ "$FNAME" != *"_${APP_VERSION}_"* ]] && [[ "$FNAME" != *"_${CHANNEL}_"* ]] && [[ "$FNAME" != *"_${PLATFORM}_"* ]] && [[ "$FNAME" != "asset-manifest"* ]] && [[ "$FNAME" != "base-assets"* ]]; then
        continue
    fi

    REMOTE_PATH="$BASE_FOLDER/$APP_VERSION/$CHANNEL/$FNAME"
    remote_delete "$REMOTE_PATH"
    remote_upload "$FILE" "$REMOTE_PATH"
    FILE_COUNT=$((FILE_COUNT + 1))
done

if [[ -d "$OUTPUT_DIR/asset-store" ]]; then
    echo "Uploading hashed assets..."
    for FILE in "$OUTPUT_DIR/asset-store"/*; do
        [[ -f "$FILE" ]] || continue
        FNAME=$(basename "$FILE")
        REMOTE_PATH="$BASE_FOLDER/assets/$FNAME"
        remote_upload "$FILE" "$REMOTE_PATH"
        FILE_COUNT=$((FILE_COUNT + 1))
    done
fi
echo "  ✓ $FILE_COUNT file(s) uploaded (patches + bundles + assets)"

echo "Uploading ota_registry.json..."
REMOTE_REGISTRY="$BASE_FOLDER/ota_registry.json"
remote_delete "$REMOTE_REGISTRY"
remote_upload "$REGISTRY_FILE" "$REMOTE_REGISTRY"
echo "  ✓ Registry uploaded"

echo ""
echo "=== Upload Complete ==="
echo "  Registry : $REMOTE_REGISTRY"
