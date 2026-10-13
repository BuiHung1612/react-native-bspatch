#!/bin/bash

# ─────────────────────────────────────────────────────────────────────────────
# OTA Upload Script — Cloudflare R2 (when OTA_R2_BUCKET is set) or a GitHub storage repository
# Uploads:  1) All .patch & .hbc files  →  {baseFolder}/{appVersion}/{channel}/
#           2) ota_registry.json         →  {baseFolder}/ota_registry.json
# ─────────────────────────────────────────────────────────────────────────────

# Env (.env.<flavor> + .env.ota) is loaded and exported by build_ota.sh
ROOT_DIR=$(pwd)

BASE_URL="${OTA_BASE_URL:-}"
BASE_FOLDER="${OTA_FOLDER:-ota}"
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


# Validate
if [[ -z "$APP_VERSION" || -z "$OTA_VERSION" ]]; then
    echo "Usage: $0 <app_version> <channel> <ota_version> <bundle_path> [platform] [--clean-remote]"
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

# Files of this app version + channel only (bundle_/patch_/asset-manifest_ carry both)
is_release_file() {
    local FNAME="$1"
    [[ "$FNAME" == *"_${APP_VERSION}_"* ]] && [[ "$FNAME" == *"_${CHANNEL}."* || "$FNAME" == *"_${CHANNEL}_"* ]]
}

# ── Cloudflare R2 (S3 API, signed by curl --aws-sigv4; no CLI needed) ────────
if [[ -n "${OTA_R2_BUCKET:-}" ]]; then
    : "${OTA_R2_ACCOUNT_ID:?set OTA_R2_ACCOUNT_ID}" "${OTA_R2_ACCESS_KEY_ID:?set OTA_R2_ACCESS_KEY_ID}" "${OTA_R2_SECRET_ACCESS_KEY:?set OTA_R2_SECRET_ACCESS_KEY}"
    R2_URL="https://${OTA_R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${OTA_R2_BUCKET}"
    r2() { curl -sS --aws-sigv4 "aws:amz:auto:s3" --user "$OTA_R2_ACCESS_KEY_ID:$OTA_R2_SECRET_ACCESS_KEY" "$@"; }
    # "patch_1.0.4_v4_to_v7_…" → "patch v4 → v7", "bundle_…_v7_…" → "bundle v7"
    pretty() {
        case "$1" in
            patch_*) echo "$1" | sed -E 's/.*_v([0-9]+)_to_v([0-9]+)_.*/patch v\1 → v\2/' ;;
            bundle_*) echo "$1" | sed -E 's/.*_v([0-9]+)_.*/bundle v\1/' ;;
            asset-manifest_*) echo "asset manifest" ;;
            *) echo "$1" ;;
        esac
    }
    r2_put() { # <file> <key> <cache-control> <label>
        local SIZE PROGRESS=(-s) BAR=false
        SIZE=$(wc -c < "$1" | tr -d ' ')
        # Progress bar for big files (bundles) in a terminal; erased once done
        if [ -t 1 ] && [ "$SIZE" -gt 1048576 ]; then printf "        ↑ %s\n" "$4"; PROGRESS=(-#); BAR=true; fi
        COLUMNS=60 curl -S "${PROGRESS[@]}" -f --aws-sigv4 "aws:amz:auto:s3" --user "$OTA_R2_ACCESS_KEY_ID:$OTA_R2_SECRET_ACCESS_KEY" \
            -X PUT -T "$1" -H "Cache-Control: $3" "$R2_URL/$2" -o /dev/null || { echo "  ❌ Upload failed: $2"; exit 1; }
        if [ "$BAR" = true ]; then printf "\033[2A\033[K\n\033[K\033[1A"; fi
        printf "        ${GREEN}✓${RESET} %s %s\n" "$(padr "$4" 16)" "$(human_size "$SIZE")"
    }
    RELEASE_PREFIX="$BASE_FOLDER/$APP_VERSION/$CHANNEL"
    IMMUTABLE="public, max-age=31536000, immutable"

    if [ "$CLEAN_REMOTE" = true ]; then
        # ponytail: one ListObjectsV2 page (1000 keys); a release+channel holds far fewer
        LISTING=$(r2 -f "$R2_URL?list-type=2&prefix=$RELEASE_PREFIX/") || { echo "  ❌ Listing $RELEASE_PREFIX/ failed"; exit 1; }
        DELETED=0; BUNDLES=0; PATCHES=0; MANIFESTS=0
        for KEY in $(echo "$LISTING" | grep -o '<Key>[^<]*</Key>' | sed 's/<[^>]*>//g'); do
            r2 -f -X DELETE "$R2_URL/$KEY" -o /dev/null || { echo "  ❌ Delete failed: $KEY"; exit 1; }
            DELETED=$((DELETED + 1))
            case "$KEY" in *.hbc) BUNDLES=$((BUNDLES + 1)) ;; *.patch) PATCHES=$((PATCHES + 1)) ;; *.json) MANIFESTS=$((MANIFESTS + 1)) ;; esac
            if [ -t 1 ]; then printf "\r\033[K  ${DIM}%-9s${RESET} deleting… %d" "remote" "$DELETED"; fi
        done
        if [ -t 1 ]; then printf "\r\033[K"; fi
        info remote "$DELETED object(s) deleted ${DIM}($BUNDLES bundles · $PATCHES patches · $MANIFESTS manifests)${RESET}"
    else
        # Only this version's files: earlier bundles/patches are already uploaded and never change
        RELEASE_FILES=()
        for FILE in "$OUTPUT_DIR"/*_v"${OTA_VERSION}"_*.{patch,hbc,json}; do
            [[ -f "$FILE" ]] && is_release_file "$(basename "$FILE")" && RELEASE_FILES+=("$FILE")
        done
        for FILE in "${RELEASE_FILES[@]}"; do
            FNAME=$(basename "$FILE")
            r2_put "$FILE" "$RELEASE_PREFIX/$FNAME" "$IMMUTABLE" "$(pretty "$FNAME")"
        done
        # Content-addressed assets: upload only hashes the bucket doesn't have yet
        ASSETS=("$OUTPUT_DIR"/asset-store/*)
        [[ -f "${ASSETS[0]}" ]] || ASSETS=()
        N=0; NEW=0; NEW_BYTES=0
        for FILE in "${ASSETS[@]}"; do
            N=$((N + 1))
            KEY="$BASE_FOLDER/assets/$(basename "$FILE")"
            if ! r2 -f -I "$R2_URL/$KEY" -o /dev/null 2>/dev/null; then
                r2 -f -X PUT -T "$FILE" -H "Cache-Control: $IMMUTABLE" "$R2_URL/$KEY" -o /dev/null || { echo "  ❌ Upload failed: $KEY"; exit 1; }
                NEW=$((NEW + 1)); NEW_BYTES=$((NEW_BYTES + $(wc -c < "$FILE")))
            fi
            if [ -t 1 ]; then printf "\r\033[K        ${DIM}assets %d/%d checked${RESET}" "$N" "${#ASSETS[@]}"; fi
        done
        if [ -t 1 ] && [ ${#ASSETS[@]} -gt 0 ]; then printf "\r\033[K"; fi
        printf "        ${GREEN}✓${RESET} %s %s\n" "$(padr assets 16)" "${#ASSETS[@]} · $NEW new ($(human_size "$NEW_BYTES"))"
    fi
    # Registry last: clients never see a version whose files aren't uploaded yet
    if [ "$CLEAN_REMOTE" = true ]; then
        r2 -f -X PUT -T "$REGISTRY_FILE" -H "Cache-Control: no-cache" "$R2_URL/$BASE_FOLDER/ota_registry.json" -o /dev/null || { echo "  ❌ Upload failed: ota_registry.json"; exit 1; }
        info registry "uploaded"
    else
        r2_put "$REGISTRY_FILE" "$BASE_FOLDER/ota_registry.json" "no-cache" "registry"
    fi
    exit 0
fi

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
        echo "  Resetting remote storage state for channel '$CHANNEL' ..."
        rm -rf "$GH_REPO_DIR/$BASE_FOLDER/$APP_VERSION/${CHANNEL:?}"
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
    # Fallback identity only where none is configured (e.g. CI); never override the user's
    git config user.name >/dev/null || git config user.name "react-native-bspatch"
    git config user.email >/dev/null || git config user.email "react-native-bspatch@users.noreply.github.com"
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
