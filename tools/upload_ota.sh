#!/bin/bash

# ─────────────────────────────────────────────────────────────────────────────
# OTA Upload Script — Cloudflare R2
# Uploads:  1) This version's .hbc.gz, .patch, .json                     → {baseFolder}/{appVersion}/{channel}/
#           2) New content-addressed assets                              → {baseFolder}/assets/
#           3) ota_registry.json, last                                   → {baseFolder}/ota_registry.json
# ─────────────────────────────────────────────────────────────────────────────

# Called by build_ota.sh inside its Upload/Remote step: env (.env.<flavor> + .env.ota)
# and the step_progress/step_fail/run_logged helpers are exported from there
ROOT_DIR=$(pwd)

BASE_FOLDER="${OTA_FOLDER:-ota}"
APP_VERSION="$1"
CHANNEL="$2"
OTA_VERSION="$3"
# $4 (bundle path) is unused: this version's files are picked up from the output dir
PLATFORM="$5"

REGISTRY_FILE="$ROOT_DIR/ota_registry.json"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
# Result for build_ota.sh's step line and summary (sourced there)
report() { printf '%s=%q\n' "$1" "$2" >> "${BSPATCH_REPORT:-/dev/null}"; }
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
: "${OTA_R2_ACCOUNT_ID:?set OTA_R2_ACCOUNT_ID}" "${OTA_R2_ACCESS_KEY_ID:?set OTA_R2_ACCESS_KEY_ID}" "${OTA_R2_SECRET_ACCESS_KEY:?set OTA_R2_SECRET_ACCESS_KEY}"
R2_URL="https://${OTA_R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${OTA_R2_BUCKET}"
r2() { curl -sS --aws-sigv4 "aws:amz:auto:s3" --user "$OTA_R2_ACCESS_KEY_ID:$OTA_R2_SECRET_ACCESS_KEY" "$@"; }
# "patch_1.0.4_v4_to_v7_…" → "patch v4 → v7", "bundle_…_v7_…" → "bundle v7"
pretty() {
    case "$1" in
        patch_*) echo "$1" | sed -E 's/.*_v([0-9]+)_to_v([0-9]+)_.*/patch v\1 → v\2/' ;;
        bundle_*) echo "$1" | sed -E 's/.*_v([0-9]+)_.*/bundle v\1/' ;;
        asset-manifest_*) echo "asset manifest" ;;
    release_*) echo "release info" ;;
        *) echo "$1" ;;
    esac
}
TOTAL_BYTES=0
r2_put() { # <file> <key> <cache-control> <label>
    local SIZE; SIZE=$(file_size "$1")
    RUN_NOTE="↑ $4 · $(human_size "$SIZE")" run_logged "$WORK/curl.log" \
        r2 -f -X PUT -T "$1" -H "Cache-Control: $3" "$R2_URL/$2" -o /dev/null \
        || { step_fail "upload failed: $2"; cat "$WORK/curl.log"; exit 1; }
    TOTAL_BYTES=$((TOTAL_BYTES + SIZE))
}
RELEASE_PREFIX="$BASE_FOLDER/$APP_VERSION/$CHANNEL"
IMMUTABLE="public, max-age=31536000, immutable"

if [ "$CLEAN_REMOTE" = true ]; then
    # ponytail: one ListObjectsV2 page (1000 keys); a release+channel holds far fewer
    LISTING=$(r2 -f "$R2_URL?list-type=2&prefix=$RELEASE_PREFIX/") || { step_fail "listing $RELEASE_PREFIX/ failed"; exit 1; }
    DELETED=0; BUNDLES=0; PATCHES=0; MANIFESTS=0
    for KEY in $(echo "$LISTING" | grep -o '<Key>[^<]*</Key>' | sed 's/<[^>]*>//g'); do
        r2 -f -X DELETE "$R2_URL/$KEY" -o /dev/null || { step_fail "delete failed: $KEY"; exit 1; }
        DELETED=$((DELETED + 1))
        case "$KEY" in *.hbc) BUNDLES=$((BUNDLES + 1)) ;; *.patch) PATCHES=$((PATCHES + 1)) ;; *.json) MANIFESTS=$((MANIFESTS + 1)) ;; esac
        step_progress "deleting… $DELETED"
    done
    # Registry last: clients never see a version whose files aren't uploaded yet
    r2 -f -X PUT -T "$REGISTRY_FILE" -H "Cache-Control: no-cache" "$R2_URL/$BASE_FOLDER/ota_registry.json" -o /dev/null || { step_fail "upload failed: ota_registry.json"; exit 1; }
    report UP_SIZE "$DELETED deleted"
    report UP_NOTE "$BUNDLES bundles · $PATCHES patches · $MANIFESTS manifests · registry updated"
    exit 0
fi

# Only this version's files: earlier bundles/patches are already uploaded and never change.
# The bundle ships as its .gz only (written by update_registry.js): clients and later
# `patch` runs decompress it, so the raw .hbc never needs to be on storage.
for FILE in "$OUTPUT_DIR"/*_v"${OTA_VERSION}"_*.{patch,gz,json}; do
    [[ -f "$FILE" ]] || continue
    FNAME=$(basename "$FILE")
    is_release_file "$FNAME" || continue
    r2_put "$FILE" "$RELEASE_PREFIX/$FNAME" "$IMMUTABLE" "$(pretty "$FNAME")"
    if [[ "$FNAME" == *.hbc.gz ]]; then report UP_GZIP_BYTES "$(file_size "$FILE")"; fi
done

# Content-addressed assets: upload only hashes the bucket doesn't have yet.
# One listing (1000 keys a page) instead of a HEAD request per asset.
ASSETS=("$OUTPUT_DIR"/asset-store/*)
[[ -f "${ASSETS[0]}" ]] || ASSETS=()
if [ ${#ASSETS[@]} -gt 0 ]; then
    step_progress "checking ${#ASSETS[@]} assets…"
    : > "$WORK/remote-assets"
    AFTER=""
    while :; do
        PAGE=$(r2 -f "$R2_URL?list-type=2&prefix=$BASE_FOLDER/assets/${AFTER:+&start-after=$AFTER}") || { step_fail "listing $BASE_FOLDER/assets/ failed"; exit 1; }
        echo "$PAGE" | grep -o '<Key>[^<]*</Key>' | sed 's/<[^>]*>//g' >> "$WORK/remote-assets"
        [[ "$PAGE" == *"<IsTruncated>true</IsTruncated>"* ]] || break
        AFTER=$(tail -n 1 "$WORK/remote-assets")
    done
    NEW=0; NEW_BYTES=0
    for FILE in "${ASSETS[@]}"; do
        KEY="$BASE_FOLDER/assets/$(basename "$FILE")"
        grep -qxF "$KEY" "$WORK/remote-assets" && continue
        step_progress "↑ asset $((NEW + 1)) · $(basename "$FILE")"
        r2 -f -X PUT -T "$FILE" -H "Cache-Control: $IMMUTABLE" "$R2_URL/$KEY" -o /dev/null || { step_fail "upload failed: $KEY"; exit 1; }
        NEW=$((NEW + 1)); NEW_BYTES=$((NEW_BYTES + $(file_size "$FILE")))
    done
    report UP_ASSETS "$NEW new of ${#ASSETS[@]} · $(human_size "$NEW_BYTES")"; TOTAL_BYTES=$((TOTAL_BYTES + NEW_BYTES))
fi

# Registry last: clients never see a version whose files aren't uploaded yet
r2_put "$REGISTRY_FILE" "$BASE_FOLDER/ota_registry.json" "no-cache" "registry"
report UP_SIZE "$(human_size "$TOTAL_BYTES")"
report UP_DEST "R2 $OTA_R2_BUCKET"
