#!/bin/bash

# ─────────────────────────────────────────────────────────────────────────────
# OTA Build Script — incremental, one version per run
#
# v1 is the store build. Every OTA version ships a full bundle; patches are built
# only from earlier OTA versions (v2+), whose bundles are byte-identical on device.
# Clients on the store build download the full bundle once, then patch.
#
# Usage (npx react-native-bspatch ...):
#   patch [android|ios] [--flavor staging] [--release-version 1.0.4] [-m "notes"] [-y] [--reset-cache]
#         [--dry-run] [--json]  → build + publish the next OTA (both platforms if omitted)
#   promote --from <flavor> [--source-version N] --flavor <target>
#                               → publish another flavor's bundle here, no build
#   rollback --to N             → publish vN's bundle again as the next version, no build
#   status | doctor             → what's live for this release / check the whole setup
#   disable N | enable N | rollout N <percent> | mandatory N [--off] | qa N --ids a,b
#                               → release controls on the live version (registry only)
#   reset [--flavor ...] [--push] → wipe this release's OTAs
#   setup                       → wire OtaBundleResolver + runtime fingerprint into the native project
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
    --reset-cache) RESET_CACHE=true ;;
    -m|--message|--notes) export BSPATCH_NOTES="$2"; NOTES_GIVEN=true; shift ;;
    --dry-run) DRY_RUN=true ;;
    --json) JSON_OUT=true ;;
    --from) SOURCE_FLAVOR="$2"; shift ;;
    --source-version|--to) SOURCE_VERSION="$2"; shift ;;
    --ids) ADMIN_IDS="$2"; shift ;;
    --off) ADMIN_OFF=true ;;
    patch) ACTION="ota" ;;
    promote) ACTION="ota"; PUBLISH_MODE="promote" ;;
    rollback) ACTION="ota"; PUBLISH_MODE="rollback" ;;
    status|doctor|disable|enable|rollout|mandatory|qa) ACTION="admin"; ADMIN_CMD="$1" ;;
    [0-9]*) ADMIN_ARGS+=("$1") ;;
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
# promote: another flavor's latest (or --source-version) bundle; rollback: this flavor's vN
if [ "$PUBLISH_MODE" = "promote" ] && [ -z "$SOURCE_FLAVOR" ]; then
  echo "❌ promote needs --from <flavor> (e.g. promote --from staging --flavor production)"; exit 1
fi
if [ "$PUBLISH_MODE" = "rollback" ]; then
  if [ -z "$SOURCE_VERSION" ]; then echo "❌ rollback needs --to <version> (see 'status')"; exit 1; fi
  SOURCE_FLAVOR="$FLAVOR"
fi
SOURCE_FLAVOR=$(echo "$SOURCE_FLAVOR" | tr '[:upper:]' '[:lower:]')
case "$SOURCE_FLAVOR" in dev) SOURCE_FLAVOR="development" ;; prod) SOURCE_FLAVOR="production" ;; esac

# Configuration
FLAVOR_LOWER=$(echo "$FLAVOR" | tr '[:upper:]' '[:lower:]')
if [ "$FLAVOR_LOWER" = "dev" ]; then FLAVOR_LOWER="development"; fi
if [ "$FLAVOR_LOWER" = "prod" ]; then FLAVOR_LOWER="production"; fi

# ── Output (exported: upload_ota.sh prints in the same layout) ────────────────
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[38;5;84m'; YELLOW=$'\033[38;5;221m'
  CYAN=$'\033[38;5;81m'; PINK=$'\033[38;5;213m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; CYAN=""; PINK=""; RESET=""
fi
# Pad to N characters, not bytes ("→" is 3 bytes, printf %-Ns counts bytes)
padr() { local LC_ALL=en_US.UTF-8; printf "%s%*s" "$1" $(( $2 > ${#1} ? $2 - ${#1} : 0 )) ""; }
info() { printf "  ${CYAN}%s${RESET} %s\n" "$(padr "$1" 9)" "$2"; }   # "  storage   R2 bucket"
badge() { # <NAME> → " NAME " on a colored background (plain without a terminal)
  local C
  case "$1" in
    BUILD) C="97;48;5;33" ;; DIFF) C="97;48;5;129" ;; SHIP) C="30;48;5;44" ;; DONE) C="30;48;5;42" ;; FAIL) C="97;48;5;160" ;;
    IOS) C="97;48;5;240" ;; ANDROID) C="30;48;5;113" ;; *) C="97;48;5;57" ;;
  esac
  if [ -n "$RESET" ]; then printf "\033[1;%sm %-5s \033[0m" "$C" "$1"; else printf " %-5s " "$1"; fi
}
export BOLD DIM RED GREEN YELLOW CYAN PINK RESET
if [ "$ACTION" != "setup" ]; then
  if [ "$ACTION" = "ota" ]; then TITLE="patch ${PLATFORM_ARG:-android + ios}"; else TITLE="$ACTION"; fi
  PKG_VERSION=$(node -p "require(process.argv[1]).version" "$SCRIPT_DIR/../package.json" 2>/dev/null)
  printf "\n%s  ${BOLD}%s${RESET} ${DIM}·${RESET} ${PINK}%s${RESET} ${DIM}· v%s${RESET}\n\n" "$(badge BSPATCH)" "$TITLE" "$FLAVOR_LOWER" "$PKG_VERSION"
fi

# ── Environment ──────────────────────────────────────────────────────────────
# .env.<flavor>: OTA_BASE_URL / OTA_FOLDER, the same values react-native-config bakes into the app.
# .env.ota: upload secrets (OTA_R2_*). Never put them in .env.<flavor>: react-native-config
# ships every key of that file inside the APK/IPA.
# Parsed like react-native-config (KEY=VALUE, optional quotes), never executed:
# `APP_NAME=Baseform Dev` is valid dotenv but breaks `source`.
load_env() {
  ENV_LOADED="${ENV_LOADED:+$ENV_LOADED + }$(basename "$1")"
  local line k v
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]] || continue
    k="${BASH_REMATCH[1]}"; v="${BASH_REMATCH[2]%$'\r'}"; v="${v#"${v%%[![:space:]]*}"}"
    if [[ "$v" =~ ^\"(.*)\"$ ]] || [[ "$v" =~ ^\'(.*)\'$ ]]; then v="${BASH_REMATCH[1]}"; fi
    export "$k=$v"
  done < "$1"
}
if [ "$FLAVOR_LOWER" = "android" ] || [ "$FLAVOR_LOWER" = "ios" ]; then
  echo "❌ '$FLAVOR_LOWER' is a platform, not a flavor. Usage: patch $FLAVOR_LOWER [--flavor development|staging|production]"
  exit 1
fi
if [ "$ACTION" != "setup" ]; then
  if [ ! -f "$ROOT/.env.$FLAVOR_LOWER" ]; then
    AVAILABLE=$(cd "$ROOT" && ls .env.* 2>/dev/null | sed 's/^\.env\.//' | grep -vx 'ota' | tr '\n' ' ')
    echo "❌ .env.$FLAVOR_LOWER not found for flavor '$FLAVOR_LOWER'. Flavors with an env file: ${AVAILABLE:-none}"
    exit 1
  fi
  load_env "$ROOT/.env.$FLAVOR_LOWER"
  if [ -f "$ROOT/.env.ota" ]; then load_env "$ROOT/.env.ota"; fi
  info env "$ENV_LOADED"
fi

# ── Setup (project wiring only, no build env needed) ─────────────────────────
if [ "$ACTION" = "setup" ]; then
  echo "Setting up react-native-bspatch in this project..."
  node "$SCRIPT_DIR/setup_project.js" --root "$ROOT"
  exit 0
fi

# ── Build environment ──────────────────────────────────────────────────────
if [ "$ACTION" = "ota" ] && [ -z "$SOURCE_FLAVOR" ]; then
  # Kill any existing Metro processes to prevent file locks
  pkill -f "react-native/local-cli/cli.js" || true
  pkill -f "metro-config/src/index.js" || true

  # A warm cache saves most of the bundle time. Metro's cache key doesn't cover .env files,
  # so a babel plugin inlining env values would reuse another flavor's output: clear the
  # cache when this flavor's env file changed since the last build, or on --reset-cache.
  METRO_CACHE_DIR=$(node -e "console.log(require('os').tmpdir())")/metro-cache
  METRO_KEY="$FLAVOR_LOWER $(shasum -a 256 < "$ROOT/.env.$FLAVOR_LOWER" | cut -c1-16)"
  if [ "$RESET_CACHE" = true ] || [ "$(cat "$METRO_CACHE_DIR/.bspatch-env" 2>/dev/null)" != "$METRO_KEY" ]; then
    rm -rf "$METRO_CACHE_DIR" # by hand: robust vs ENOTEMPTY
    info metro "stopped · cache cleared"
  else
    info metro "stopped · cache reused ${DIM}(--reset-cache to clear)${RESET}"
  fi
  mkdir -p "$METRO_CACHE_DIR" && echo "$METRO_KEY" > "$METRO_CACHE_DIR/.bspatch-env"
fi

mkdir -p "$ROOT/android/output"
mkdir -p "$ROOT/ios/output"
# Shared registry file for dual-platform builds
REGISTRY_SHARED="$ROOT/ota_registry.json"

# ── Registry Sync ──────────────────────────────────────────────────────────
# Reset syncs too: it edits the latest remote registry instead of overwriting it with a stale local copy
if [ "$ACTION" != "setup" ]; then
    BASE_URL="${OTA_BASE_URL:-}"
    BASE_FOLDER="${OTA_FOLDER:-ota}"

    # Cloudflare R2 is the only storage for now (until custom servers get their own support)
    if [[ -z "${OTA_R2_BUCKET:-}" ]]; then
      echo "  ❌ OTA_R2_BUCKET not set: add OTA_R2_ACCOUNT_ID / OTA_R2_BUCKET / OTA_R2_ACCESS_KEY_ID / OTA_R2_SECRET_ACCESS_KEY to .env.ota"
      exit 1
    fi
    info storage "R2 $OTA_R2_BUCKET → $BASE_URL/$BASE_FOLDER"

    R2_URL="https://${OTA_R2_ACCOUNT_ID:?set OTA_R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${OTA_R2_BUCKET}"
    r2() { curl -sS --aws-sigv4 "aws:amz:auto:s3" --user "${OTA_R2_ACCESS_KEY_ID:?}:${OTA_R2_SECRET_ACCESS_KEY:?}" "$@"; }
    # S3 API, not the public URL: always the latest object, no CDN cache
    API_HTTP=$(r2 -o "$REGISTRY_SHARED.tmp" -w "%{http_code}" "$R2_URL/$BASE_FOLDER/ota_registry.json" || echo 0)

    if [[ "$API_HTTP" == "200" ]] && node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$REGISTRY_SHARED.tmp" 2>/dev/null; then
        mv "$REGISTRY_SHARED.tmp" "$REGISTRY_SHARED"
        info registry "synced"
    elif [[ "$API_HTTP" == "404" ]]; then
        rm -f "$REGISTRY_SHARED.tmp"
        # Remote is the source of truth: a local registry from another storage would publish
        # entries for files that don't exist here
        echo '{"apps":{}}' > "$REGISTRY_SHARED"
        info registry "new (nothing on storage yet)"
    else
        # Continuing would later push a stale local registry over the remote one
        rm -f "$REGISTRY_SHARED.tmp"
        echo "  ❌ Registry sync failed (HTTP $API_HTTP). Check network / credentials and retry."
        exit 1
    fi
fi

# ── Helper: Download from remote storage ───────────────────────────────────────
download_remote() { # <remote path> <dest>
  # --compressed: bundles are stored gzip Content-Encoded
  if r2 -f --compressed -o "$2.tmp" "$R2_URL/$1" 2>/dev/null; then
    mv "$2.tmp" "$2"
  else
    rm -f "$2.tmp"
    return 1
  fi
}

# ── Helper: compute SHA-256 hash ──────────────────────────────────────────────
sha256() {
  shasum -a 256 "$1" | awk '{print $1}'
}

# ── Progress ───────────────────────────────────────────────────────────────────
#  BUILD   Bundle JS   5.8 MB     ██████░░░░░░░░  18s
#  BUILD   Hermes      ⠹ 12s · <last log line>         ← running (terminal only, redrawn in place)
# Bars are each step's share of the platform's total time, so finished rows show an empty
# bar and timeline_redraw fills them in after the last step.
human_size() {
  awk -v b="$1" 'BEGIN { split("B KB MB GB", u); i = 1; while (b >= 1024 && i < 4) { b /= 1024; i++ }
    printf (i == 1 ? "%d %s" : "%.1f %s"), b, u[i] }'
}
file_size() { wc -c < "$1" | tr -d ' '; }
row() { # <badge> <label> <detail> <time> [bar] [time color]
  printf " %s  %s ${BOLD}%s${RESET} %s${6:-$DIM}%4s${RESET}\n" "$(badge "$1")" "$(padr "$2" 11)" "$(padr "$3" 12)" "${5:+$5 }" "$4"
}
bar() { # <secs> <total secs> <badge>
  local W=14 N=0 I C
  if [ "$2" -gt 0 ]; then N=$(( ($1 * W + $2 - 1) / $2 )); fi
  if [ "$N" -gt "$W" ]; then N=$W; fi
  case "$3" in BUILD) C=75 ;; DIFF) C=177 ;; *) C=87 ;; esac
  if [ -n "$RESET" ]; then printf "\033[38;5;%sm" "$C"; fi
  for (( I = 0; I < N; I++ )); do printf "█"; done
  printf "%s" "$RESET$DIM"
  for (( I = N; I < W; I++ )); do printf "░"; done
  printf "%s" "$RESET"
}
ROWS=() # "badge|label|detail|secs" of the current platform's finished steps
step() { # <label> <badge>
  STEP_LABEL="$1"; STEP_BADGE="$2"; STEP_START=$(date +%s)
  export STEP_LABEL STEP_BADGE STEP_START
  step_progress
}
step_progress() { # [text]
  [ -t 1 ] || return 0
  local F=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)
  SPIN=$(( (${SPIN:-0} + 1) % 10 ))
  printf "\r\033[K %s  %s ${CYAN}%s${RESET} ${DIM}%s${RESET}" "$(badge "$STEP_BADGE")" "$(padr "$STEP_LABEL" 11)" "${F[$SPIN]}" "$1"
}
step_done() { # <detail>
  local SECS=$(( $(date +%s) - STEP_START ))
  ROWS+=("$STEP_BADGE|$STEP_LABEL|$1|$SECS")
  if [ -t 1 ]; then printf "\r\033[K"; row "$STEP_BADGE" "$STEP_LABEL" "$1" "${SECS}s" "$(bar 0 0 "$STEP_BADGE")"
  else row "$STEP_BADGE" "$STEP_LABEL" "$1" "${SECS}s"; fi
}
step_fail() { # [message]; error details go below
  if [ -t 1 ]; then printf "\r\033[K"; fi
  printf " %s  %s ${RED}%s${RESET}\n" "$(badge FAIL)" "$(padr "$STEP_LABEL" 11)" "${1:-failed}"
}
timeline_redraw() { # rewrites the ROWS lines above the cursor with filled bars
  [ -t 1 ] && [ ${#ROWS[@]} -gt 0 ] || return 0
  local R B L D S TOTAL=0 MAX=0
  for R in "${ROWS[@]}"; do
    TOTAL=$(( TOTAL + ${R##*|} )); if [ "${R##*|}" -gt "$MAX" ]; then MAX=${R##*|}; fi
  done
  printf "\033[%dA" ${#ROWS[@]}
  for R in "${ROWS[@]}"; do
    IFS='|' read -r B L D S <<< "$R"
    printf "\r\033[K"
    # the slowest step stands out
    if [ "$S" -eq "$MAX" ] && [ "$MAX" -gt 0 ]; then row "$B" "$L" "$D" "${S}s" "$(bar "$S" "$TOTAL" "$B")" "$BOLD$YELLOW"
    else row "$B" "$L" "$D" "${S}s" "$(bar "$S" "$TOTAL" "$B")"; fi
  done
}
detail() { printf "%10s%s %s\n" "" "$(padr "$1" 9)" "$2"; } # line under a step
vis_len() { # characters on screen: color codes don't count
  local LC_ALL=en_US.UTF-8 S
  S=$(printf "%s" "$1" | sed $'s/\033\\[[0-9;]*m//g')
  printf "%s" "${#S}"
}
box() { # <line>… — rounded box sized to the widest line, border shading blue → green
  local L W=0 N I EDGE="" PAL=(39 38 44 43 49 48 84 83 119 118)
  for L in "$@"; do N=$(vis_len "$L"); if [ "$N" -gt "$W" ]; then W=$N; fi; done
  local A="" Z=""; if [ -n "$RESET" ]; then A=$'\033[38;5;39m'; Z=$'\033[38;5;118m'; fi
  for (( I = 0; I < W + 4; I++ )); do
    if [ -n "$RESET" ]; then EDGE+=$'\033[38;5;'"${PAL[$(( I * 10 / (W + 4) ))]}m"; fi
    EDGE+="─"
  done
  printf " ${A}╭%s${Z}╮${RESET}\n" "$EDGE"
  for L in "$@"; do printf " ${A}│${RESET}  %s%*s  ${Z}│${RESET}\n" "$L" $((W - $(vis_len "$L"))) ""; done
  printf " ${A}╰%s${Z}╯${RESET}\n" "$EDGE"
}
# [RUN_NOTE=…] run_logged LOG cmd… — output to LOG; in a terminal, spin with elapsed time + the log's last line
run_logged() {
  local LOG="$1"; shift
  "$@" > "$LOG" 2>&1 &
  local PID=$!
  if [ -t 1 ]; then
    local W=$(( $(tput cols 2>/dev/null || echo 80) - 40 ))
    while kill -0 "$PID" 2>/dev/null; do
      local LAST=$(tail -n 1 "$LOG" 2>/dev/null | tr -d '\r\033' | cut -c1-$(( W > 10 ? W : 10 )))
      step_progress "${RUN_NOTE:+$RUN_NOTE · }$(( $(date +%s) - STEP_START ))s${LAST:+ · $LAST}"
      sleep 0.2
    done
  fi
  wait "$PID"
}
# upload_ota.sh runs inside the Upload/Remote step: it spins, fails, and reports back through $BSPATCH_REPORT
export -f padr info badge human_size file_size step_progress step_fail run_logged

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
  if [ "$ACTION" = "reset" ]; then PROMPT_WHAT="Release version to RESET ($FLAVOR_LOWER, android + ios)"
  else PROMPT_WHAT="Release version for ${PLATFORM_ARG:-android + ios} ($FLAVOR_LOWER)"; fi
  read -r -p "  ${BOLD}?${RESET} $PROMPT_WHAT [${APP_VERSION:-none detected}]: " INPUT_VERSION
  INPUT_VERSION="${INPUT_VERSION// /}"
  APP_VERSION="${INPUT_VERSION:-$APP_VERSION}"
fi

if [ -z "$APP_VERSION" ]; then
  echo "❌ Could not read the native app version. Pass --release-version <x.y.z>."
  exit 1
fi
info release "$APP_VERSION"

# Release notes: shown in the summary and kept in release_*.json (public) for a dashboard
if [ "$ACTION" = "ota" ] && [ -t 0 ] && [ "$CONFIRM_VERSION" = true ] && [ -z "$NOTES_GIVEN" ]; then
  read -r -p "  ${BOLD}?${RESET} Release notes ${DIM}(optional, Enter to skip)${RESET}: " BSPATCH_NOTES
  export BSPATCH_NOTES
fi

# ── Signing key: found, or created + embedded in the app (never replaces one in use) ──
if [ "$ACTION" = "ota" ]; then
  KEY_FLAGS=(); if [ -t 0 ]; then KEY_FLAGS=(--interactive); fi
  KEY_NOTE=$(node "$SCRIPT_DIR/ensure_signing_key.js" "$ROOT" "$REGISTRY_SHARED" "${KEY_FLAGS[@]}") || exit 1
  info signing "$KEY_NOTE"
  # Native wiring (resolver, fingerprint build step) kept current without a separate setup run
  WIRED=$(node "$SCRIPT_DIR/setup_project.js" --root "$ROOT" --quiet | paste -sd ',' - | sed 's/,/, /g')
  if [ -n "$WIRED" ]; then
    info wiring "${YELLOW}updated: $WIRED${RESET} ${DIM}(commit; store builds from now on carry it)${RESET}"
  else
    info wiring "ok"
  fi
fi

# ── Release controls, status, doctor (registry only, nothing is built) ──
if [ "$ACTION" = "admin" ]; then
  if [ "$ADMIN_CMD" = "doctor" ]; then
    exec node "$SCRIPT_DIR/doctor.js" "$ROOT" "$REGISTRY_SHARED" "$APP_VERSION" "$FLAVOR_LOWER" "$BASE_URL" "$BASE_FOLDER"
  fi
  RELEASES_DIR=$(mktemp -d)
  if [ "$ADMIN_CMD" = "status" ]; then
    # The live version's release_*.json per platform, for who/when/notes/sizes
    for F in $(node -e '
      const [reg, app, flavor] = process.argv.slice(1);
      const g = JSON.parse(require("fs").readFileSync(reg, "utf8")).apps?.[app]?.flavors?.[flavor];
      for (const p of new Set((g?.patches || []).map(e => e.platform)))
        console.log(`release_${app}_v${g.latestOtaVersion}_${p}_${flavor}.json`);
    ' "$REGISTRY_SHARED" "$APP_VERSION" "$FLAVOR_LOWER"); do
      download_remote "$BASE_FOLDER/$APP_VERSION/$FLAVOR_LOWER/$F" "$RELEASES_DIR/$F" || true
    done
  fi
  ADMIN_FLAGS=(); if [ -n "$PLATFORM_ARG" ]; then ADMIN_FLAGS+=(--platform "$PLATFORM_ARG"); fi
  if [ -n "$ADMIN_IDS" ]; then ADMIN_FLAGS+=(--ids "$ADMIN_IDS"); fi
  if [ "$ADMIN_OFF" = true ]; then ADMIN_FLAGS+=(--off); fi
  if [ "$JSON_OUT" = true ]; then ADMIN_FLAGS+=(--json); fi
  printf "\n"
  set +e
  node "$SCRIPT_DIR/ota_admin.js" "$ADMIN_CMD" "$REGISTRY_SHARED" "$APP_VERSION" "$FLAVOR_LOWER" "$RELEASES_DIR" \
    "${ADMIN_FLAGS[@]}" "${ADMIN_ARGS[@]}"
  ADMIN_EXIT=$?
  set -e
  rm -rf "$RELEASES_DIR"
  # Exit 3: the registry changed and goes back to storage
  if [ $ADMIN_EXIT -eq 3 ]; then
    if [ "$DRY_RUN" = true ]; then
      info registry "not uploaded ${DIM}(dry run)${RESET}"
    else
      r2 -f -X PUT -T "$REGISTRY_SHARED" -H "Cache-Control: no-cache" "$R2_URL/$BASE_FOLDER/ota_registry.json" -o /dev/null \
        || { echo "  ❌ Uploading the registry failed"; exit 1; }
      info registry "uploaded · clients see it on their next check"
    fi
    exit 0
  fi
  exit $ADMIN_EXIT
fi

# ── Reset ─────────────────────────────────────────────────────────────────────
if [ "$ACTION" = "reset" ]; then
  # Reset only the specific flavor in registry JSON if registry exists
  LATEST=1
  if [ -f "$REGISTRY_SHARED" ]; then
    LATEST=$(node -e "
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
        console.log(flavors?.['$FLAVOR_LOWER']?.latestOtaVersion || 1);
      } catch(e) { console.log(1); }
    ")
  else
    echo '{"apps":{}}' > "$REGISTRY_SHARED"
  fi

  # Delete only this app version + flavor
  for D in "$ROOT/android/output" "$ROOT/ios/output"; do
    find "$D" -maxdepth 1 -type f -name "*_${APP_VERSION}_*" -name "*_${FLAVOR_LOWER}[._]*" -delete 2>/dev/null || true
    find "$D" -maxdepth 1 -type f -name "asset-manifest-v*_${FLAVOR_LOWER}.json" -delete 2>/dev/null || true # legacy names
  done

  info local "cleared $APP_VERSION/$FLAVOR_LOWER · next OTA is v$((LATEST + 1))"

  if [ "$PUSH_REMOTE" = true ]; then
      printf "\n"; step "Remote" SHIP
      export BSPATCH_REPORT=$(mktemp)
      bash "$SCRIPT_DIR/upload_ota.sh" "$APP_VERSION" "$FLAVOR_LOWER" "0" "" "ios" "--clean-remote" || exit 1
      . "$BSPATCH_REPORT"; rm -f "$BSPATCH_REPORT"
      step_done "$UP_SIZE"
      if [ -n "$UP_NOTE" ]; then detail "" "${DIM}$UP_NOTE${RESET}"; fi
  else
      info remote "unchanged ${DIM}(add --push to delete on storage)${RESET}"
  fi
  exit 0
fi

# ── Ensure bsdiff compiled ───────────────────────────────────────────────────
if [ ! -f "$BSDIFF" ] || [ "$SCRIPT_DIR/bsdiff.c" -nt "$BSDIFF" ]; then
  clang -O2 -D BSDIFF_EXECUTABLE -o "$BSDIFF" "$SCRIPT_DIR/bsdiff.c" -lbz2
  info bsdiff "compiled"
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

  printf "\n%s  ${BOLD}%s${RESET} ${DIM}· v%s →${RESET} ${BOLD}${GREEN}v%s${RESET}\n\n" "$(badge "$(echo "$PLATFORM" | tr '[:lower:]' '[:upper:]')")" "$APP_VERSION" "$CURRENT" "$NEXT"
  ROWS=()
  local PLATFORM_START=$SECONDS

  # ── Bundle ──
  # Workspace for building
  local WORKSPACE="$OUTPUT/workspace"
  mkdir -p "$WORKSPACE"

  local BUNDLE_NAME="bundle_${APP_VERSION}_v${NEXT}_${PLATFORM}_${FLAVOR_LOWER}.hbc"
  local NEW_BUNDLE_PATH="$OUTPUT/$BUNDLE_NAME"
  local ASSET_MANIFEST_FILE="$OUTPUT/asset-manifest_${APP_VERSION}_v${NEXT}_${PLATFORM}_${FLAVOR_LOWER}.json"
  local ASSET_STORE_DIR="$OUTPUT/asset-store"
  # This version's assets only: upload checks each file, earlier versions' are already on storage
  rm -rf "$ASSET_STORE_DIR"; mkdir -p "$ASSET_STORE_DIR"
  unset BSPATCH_FINGERPRINT

  if [ -n "$SOURCE_FLAVOR" ]; then
    # ── Source: a bundle already on storage (promote / rollback), nothing is built ──
    local SRC_V="${SOURCE_VERSION:-$(node -e '
      const [reg, app, flavor] = process.argv.slice(1);
      console.log(JSON.parse(require("fs").readFileSync(reg, "utf8")).apps?.[app]?.flavors?.[flavor]?.latestOtaVersion || "");
    ' "$REGISTRY_SHARED" "$APP_VERSION" "$SOURCE_FLAVOR")}"
    local SRC_PREFIX="$BASE_FOLDER/$APP_VERSION/$SOURCE_FLAVOR"
    local SRC_SUFFIX="${APP_VERSION}_v${SRC_V}_${PLATFORM}_${SOURCE_FLAVOR}"
    step "Source" BUILD
    if [ -z "$SRC_V" ]; then step_fail "$SOURCE_FLAVOR has no OTA for $APP_VERSION"; exit 1; fi
    step_progress "fetching $SOURCE_FLAVOR v$SRC_V…"
    if ! download_remote "$SRC_PREFIX/bundle_$SRC_SUFFIX.hbc.gz" "$WORKSPACE/source.hbc.gz"; then
      step_fail "$SOURCE_FLAVOR v$SRC_V has no $PLATFORM bundle on storage"; exit 1
    fi
    gunzip -c "$WORKSPACE/source.hbc.gz" > "$NEW_BUNDLE_PATH"
    # Assets are content-addressed and already on storage: its manifest is all this needs
    if ! download_remote "$SRC_PREFIX/asset-manifest_$SRC_SUFFIX.json" "$ASSET_MANIFEST_FILE"; then
      step_fail "$SOURCE_FLAVOR v$SRC_V has no asset manifest on storage"; exit 1
    fi
    # Its fingerprint, not this checkout's: the bundle was built from that commit
    if download_remote "$SRC_PREFIX/release_$SRC_SUFFIX.json" "$WORKSPACE/source-release.json"; then
      export BSPATCH_FINGERPRINT=$(node -p 'require(process.argv[1]).runtimeFingerprint || ""' "$WORKSPACE/source-release.json")
    fi
    if [ -z "$BSPATCH_NOTES" ]; then
      if [ "$PUBLISH_MODE" = "rollback" ]; then export BSPATCH_NOTES="rollback to v$SRC_V"
      else export BSPATCH_NOTES="promoted from $SOURCE_FLAVOR v$SRC_V"; fi
    fi
    step_done "$SOURCE_FLAVOR v$SRC_V"
  else

  # Determine source bundle
  local BUILD_LOG="$WORKSPACE/bundle.log"
  if [ "$PLATFORM" == "android" ]; then
    step "Bundle JS" BUILD
    # Gradle's config noise goes to a log; shown only on failure
    if ! run_logged "$BUILD_LOG" bash -c 'cd "$1/android" && ./gradlew ":app:createBundle${2}ReleaseJsAndAssets" -Pkotlin.incremental=false --quiet' _ "$ROOT" "$FLAVOR_CAP"; then
      step_fail "Gradle bundle failed"; tail -n 40 "$BUILD_LOG"; echo "  full log: $BUILD_LOG"; exit 1
    fi
    BUNDLE_SOURCE="$ROOT/android/app/build/generated/assets/react/${FLAVOR_LOWER}Release/index.android.bundle"
  else
    step "Bundle JS" BUILD
    # Fresh dir: leftovers of deleted/renamed assets would land in the manifest
    rm -rf "$OUTPUT/assets"
    if ! run_logged "$BUILD_LOG" npx react-native bundle --platform ios --dev false --entry-file index.js \
      --bundle-output "$WORKSPACE/source.bundle" --assets-dest "$OUTPUT/assets"; then
      step_fail "bundle failed"; tail -n 40 "$BUILD_LOG"; echo "  full log: $BUILD_LOG"; exit 1
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

  step "Hermes" BUILD
  if [ "$IS_HBC" != true ]; then
    if [ -z "$HERMESC_PATH" ] || [ ! -f "$HERMESC_PATH" ]; then
      step_fail "hermesc not found"; exit 1
    fi
    # -O matches what Xcode/Gradle use for release; -w: undeclared-global warnings are expected noise
    if ! run_logged "$WORKSPACE/hermes.log" "$HERMESC_PATH" -emit-binary -O -w -out "$WORKSPACE/source.hbc" "$BUNDLE_SOURCE"; then
      step_fail "hermesc failed"; tail -n 40 "$WORKSPACE/hermes.log"; exit 1
    fi
    mv "$WORKSPACE/source.hbc" "$BUNDLE_SOURCE"
  fi

  cp "$BUNDLE_SOURCE" "$NEW_BUNDLE_PATH"
  step_done "$(human_size "$(file_size "$NEW_BUNDLE_PATH")")"

  # ── Assets ──
  local ASSETS_SRC_DIR="$ROOT/android/app/build/generated/res/react/${FLAVOR_LOWER}Release"
  if [ "$PLATFORM" == "ios" ]; then ASSETS_SRC_DIR="$OUTPUT/assets"; fi

  local ASSET_JSON_LIST="["
  local FIRST=true
  local ASSET_COUNT=0
  step "Assets" BUILD
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
      step_progress "$ASSET_COUNT files"
    done < <(find "$ASSETS_SRC_DIR" -type f -print0 2>/dev/null)
  fi
  ASSET_JSON_LIST+="]"
  step_done "$ASSET_COUNT files"

  cat > "$ASSET_MANIFEST_FILE" << EOF
{ "version": $NEXT, "appVersion": "$APP_VERSION", "platform": "$PLATFORM", "flavor": "$FLAVOR_LOWER", "assets": $ASSET_JSON_LIST }
EOF
  fi

  # ── Patches ──
  # From the last 5 OTA versions only (never v1 = store build). Clients on the
  # store build or further behind download the full bundle.
  local NEW_HASH=$(sha256 "$NEW_BUNDLE_PATH")
  local PATCHES_JSON="["
  local FIRST_FROM=$((NEXT - 5)); if [ $FIRST_FROM -lt 2 ]; then FIRST_FROM=2; fi
  local PATCH_SIZES=() PATCH_MISSING="" # "from|bytes"
  step "Patches" DIFF
  for (( i=FIRST_FROM; i<NEXT; i++ )); do
    local OLD_B="bundle_${APP_VERSION}_v${i}_${PLATFORM}_${FLAVOR_LOWER}.hbc"
    local OLD_P="$OUTPUT/$OLD_B"
    if [ ! -f "$OLD_P" ]; then
      step_progress "v$i: fetching bundle…"
      if download_remote "$BASE_FOLDER/$APP_VERSION/$FLAVOR_LOWER/$OLD_B.gz" "$OLD_P.gz"; then
        gunzip -c "$OLD_P.gz" > "$OLD_P" || rm -f "$OLD_P"
        rm -f "$OLD_P.gz"
      fi
    fi
    if [ ! -f "$OLD_P" ]; then
      PATCH_MISSING="${PATCH_MISSING:+$PATCH_MISSING, }v$i"
      continue
    fi
    local PNAME="patch_${APP_VERSION}_v${i}_to_v${NEXT}_${FLAVOR_LOWER}_${PLATFORM}.patch"
    step_progress "v$i → v$NEXT…"
    "$BSDIFF" "$OLD_P" "$NEW_BUNDLE_PATH" "$OUTPUT/$PNAME"
    PATCH_SIZES+=("$i|$(file_size "$OUTPUT/$PNAME")")
    if [ "$PATCHES_JSON" != "[" ]; then PATCHES_JSON+=", "; fi
    PATCHES_JSON+="{\"from\": $i, \"to\": $NEXT, \"file\": \"$PNAME\", \"baseHash\": \"$(sha256 "$OLD_P")\", \"bundleHash\": \"$NEW_HASH\"}"
  done
  PATCHES_JSON+="]"
  case ${#PATCH_SIZES[@]} in
    0) step_done "none" ;;
    1) step_done "1 × $(human_size "${PATCH_SIZES[0]#*|}")" ;;
    *) step_done "${#PATCH_SIZES[@]} patches" ;;
  esac

  # ── Finalize ──
  step "Upload" SHIP
  export BSPATCH_REPORT="$WORKSPACE/upload.report"; : > "$BSPATCH_REPORT"
  local REGISTRY_NOTE
  if ! REGISTRY_NOTE=$(node "$SCRIPT_DIR/update_registry.js" "$REGISTRY_SHARED" "$APP_VERSION" "$NEXT" "$PATCHES_JSON" "$PLATFORM" "$ASSET_MANIFEST_FILE" "$FLAVOR_LOWER"); then
    step_fail "registry update failed"; exit 1
  fi
  local UP_SIZE="" UP_DEST="" UP_ASSETS="" UP_GZIP_BYTES="" NATIVE_CHANGED="" VERIFY_NOTE=""
  if [ "$DRY_RUN" = true ]; then
    step_done "skipped"
  else
    bash "$SCRIPT_DIR/upload_ota.sh" "$APP_VERSION" "$FLAVOR_LOWER" "$NEXT" "$NEW_BUNDLE_PATH" "$PLATFORM" || exit 1
    . "$BSPATCH_REPORT"
    step_done "$UP_SIZE"
    # What the app will read: its own public URL, not the bucket API
    step "Verify" SHIP
    if ! VERIFY_NOTE=$(node "$SCRIPT_DIR/verify_publish.js" "$ROOT" "$BASE_URL" "$BASE_FOLDER" "$APP_VERSION" "$FLAVOR_LOWER" "$PLATFORM" "$NEXT" 2>"$WORKSPACE/verify.log"); then
      step_fail "$(head -n 1 "$WORKSPACE/verify.log")"; tail -n +2 "$WORKSPACE/verify.log"; exit 1
    fi
    step_done "$VERIFY_NOTE"
  fi
  . "$BSPATCH_REPORT"
  timeline_redraw

  # ── Summary: what each client downloads ──
  # What a client downloads for the full bundle: the gzip size on the wire
  local RAW_BYTES=$(file_size "$NEW_BUNDLE_PATH") FULL_BYTES=${UP_GZIP_BYTES:-$(file_size "$NEW_BUNDLE_PATH")} L CARD=()
  kv() { CARD+=("${CYAN}$(padr "$1" 10)${RESET}$2"); }
  if [ "$DRY_RUN" = true ]; then
    CARD+=("$(badge DONE)  ${BOLD}$PLATFORM v$NEXT built${RESET} in ${YELLOW}$((SECONDS - PLATFORM_START))s${RESET} ${DIM}· dry run, nothing uploaded${RESET}" "")
  else
    CARD+=("$(badge DONE)  ${BOLD}$PLATFORM ${GREEN}v$NEXT${RESET}${BOLD} is live${RESET} in ${YELLOW}$((SECONDS - PLATFORM_START))s${RESET} ${DIM}· $UP_DEST${RESET}" "")
  fi
  for L in "${PATCH_SIZES[@]}"; do
    kv "v${L%%|*} → v$NEXT" "${BOLD}$(human_size "${L#*|}")${RESET} patch  ${BOLD}${GREEN}$(awk -v p="${L#*|}" -v f="$FULL_BYTES" 'BEGIN { printf "−%.1f%%", 100 - p * 100 / f }')${RESET}"
  done
  kv "v1 → v$NEXT" "${BOLD}$(human_size "$FULL_BYTES")${RESET} full bundle ${DIM}(gzip · $(human_size "$RAW_BYTES") raw)${RESET}"
  if [ -n "$PATCH_MISSING" ]; then kv "$PATCH_MISSING" "${DIM}no bundle on storage → full bundle${RESET}"; fi
  if [ -n "$UP_ASSETS" ]; then kv "assets" "$UP_ASSETS"; fi
  local COMMIT=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null)
  if [ -n "$COMMIT" ]; then
    local DIRTY=""; if [ -n "$(git -C "$ROOT" status --porcelain --untracked-files=no 2>/dev/null)" ]; then DIRTY=" ${YELLOW}+ uncommitted changes${RESET}"; fi
    kv "commit" "$COMMIT ${DIM}$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)${RESET}$DIRTY"
  fi
  if [ -n "$BSPATCH_NOTES" ]; then kv "notes" "$BSPATCH_NOTES"; fi
  case "$REGISTRY_NOTE" in
    *unsigned*) kv "signing" "${YELLOW}unsigned · no ota_private_key.pem${RESET}" ;;
    *) kv "signing" "${GREEN}✓${RESET} signed" ;;
  esac
  local RELEASE_FILE="$OUTPUT/release_${APP_VERSION}_v${NEXT}_${PLATFORM}_${FLAVOR_LOWER}.json"
  local FP=$(node -p 'require(process.argv[1]).runtimeFingerprint' "$RELEASE_FILE" 2>/dev/null)
  if [ -n "$NATIVE_CHANGED" ]; then
    kv "native" "$FP ${YELLOW}changed since $NATIVE_CHANGED: only store builds of this code take it${RESET}"
  else
    kv "native" "$FP"
  fi
  printf "\n"; box "${CARD[@]}"
  if [ "$JSON_OUT" = true ]; then
    node -e 'process.stdout.write(JSON.stringify(require(process.argv[1])) + "\n")' "$RELEASE_FILE"
  fi
}

# ── Main ───────────────────────────────────────────────────────────────────

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






