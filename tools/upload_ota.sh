#!/bin/bash

# ─────────────────────────────────────────────────────────────────────────────
# OTA Upload Script — GitHub storage repository
# Uploads:  1) All .patch & .hbc files  →  {baseFolder}/{appVersion}/{channel}/
#           2) ota_registry.json         →  {baseFolder}/ota_registry.json
# ─────────────────────────────────────────────────────────────────────────────

# Load environment variables if .env exists
ROOT_DIR=$(pwd)
if [ -f "$ROOT_DIR/.env" ]; then
    set -a; . "$ROOT_DIR/.env"; set +a
fi

BASE_URL="${OTA_BASE_URL:-}"
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
echo "=== OTA Upload | App: $APP_VERSION | Channel: $CHANNEL | V$OTA_VERSION | Platform: $PLATFORM ==="
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

# Files of this app version + channel only (bundle_/patch_/asset-manifest_ carry both;
# base-assets_<platform>_<channel>.json carries just the channel)
is_release_file() {
    local FNAME="$1"
    if [[ "$FNAME" == "base-assets_"*"_${CHANNEL}.json" ]]; then return 0; fi
    [[ "$FNAME" == *"_${APP_VERSION}_"* ]] && [[ "$FNAME" == *"_${CHANNEL}."* || "$FNAME" == *"_${CHANNEL}_"* ]]
}

# ── GitHub Auto-Push Integration ──────────────────────────────────────────────
if [[ "$BASE_URL" != "https://raw.githubusercontent.com/"* ]]; then
    echo "ERROR: OTA_BASE_URL must be https://raw.githubusercontent.com/<owner>/<repo>/<branch>"
    exit 1
fi

    # Parse OWNER, REPO, BRANCH from URL
    # Example: https://raw.githubusercontent.com/hungbv-taureau/baseform-storage/main
    CLEAN_URL="${BASE_URL#https://raw.githubusercontent.com/}"
    OWNER=$(echo "$CLEAN_URL" | cut -d'/' -f1)
    REPO=$(echo "$CLEAN_URL" | cut -d'/' -f2)
    BRANCH=$(echo "$CLEAN_URL" | cut -d'/' -f3)
    if [[ -z "$BRANCH" ]]; then BRANCH="main"; fi

    # Check for gh token or env tokens
    GH_CLI_TOKEN=$(gh auth token 2>/dev/null || true)
    TOKEN="${GH_CLI_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}"
    if [[ "$TOKEN" == "baseform" ]]; then TOKEN=""; fi

    # Token goes in a per-command header, never into the clone's .git/config
    GIT_AUTH=()
    if [[ -n "$TOKEN" ]]; then
        GIT_REMOTE="https://github.com/${OWNER}/${REPO}.git"
        GIT_AUTH=(-c "http.https://github.com/.extraheader=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$TOKEN" | base64 | tr -d '\n')")
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
        git "${GIT_AUTH[@]}" -C "$GH_REPO_DIR" fetch origin "$BRANCH" 2>/dev/null || true
        git -C "$GH_REPO_DIR" checkout "$BRANCH" 2>/dev/null || true
        git -C "$GH_REPO_DIR" reset --hard "origin/$BRANCH" 2>/dev/null || true
    else
        echo "  Cloning storage repository..."
        rm -rf "$GH_REPO_DIR"
        git "${GIT_AUTH[@]}" clone --branch "$BRANCH" --depth 1 "$GIT_REMOTE" "$GH_REPO_DIR" 2>/dev/null || git "${GIT_AUTH[@]}" clone "$GIT_REMOTE" "$GH_REPO_DIR" || exit 1
        chmod 700 "$GH_REPO_DIR"
    fi

    # 2. Copy generated files into storage repo (or reset remote)
    if [ "$CLEAN_REMOTE" = true ]; then
        echo "  Resetting remote storage state for channel '$CHANNEL' (base bundle v1 + base-assets kept)..."
        find "$GH_REPO_DIR/$BASE_FOLDER/$APP_VERSION/$CHANNEL" -type f \
            -not -name "bundle_${APP_VERSION}_v1_*" -not -name 'base-assets_*' -delete 2>/dev/null || true
        mkdir -p "$GH_REPO_DIR/$BASE_FOLDER"
        cp "$REGISTRY_FILE" "$GH_REPO_DIR/$BASE_FOLDER/ota_registry.json"
        cp "$REGISTRY_FILE" "$GH_REPO_DIR/ota_registry.json" 2>/dev/null || true
    else
        TARGET_RELEASE_DIR="$GH_REPO_DIR/$BASE_FOLDER/$APP_VERSION/$CHANNEL"
        mkdir -p "$TARGET_RELEASE_DIR"
        
        echo "  Copying release files to storage repo for channel '$CHANNEL'..."
        for FILE in "$OUTPUT_DIR"/*.{patch,hbc,json}; do
            [[ -f "$FILE" ]] || continue
            FNAME=$(basename "$FILE")
            is_release_file "$FNAME" || continue
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
        
        if git "${GIT_AUTH[@]}" push origin "$BRANCH"; then
            echo "  ✓ Successfully pushed OTA release to GitHub!"
        else
            # Usually someone else pushed first: re-run so the registry is re-synced, never force-push
            echo "  ❌ Git push failed (remote changed or no write access to ${OWNER}/${REPO}). Re-run the build."
            exit 1
        fi
    fi
    cd "$ROOT_DIR"
    echo ""
    echo "=== GitHub Sync Complete ==="
