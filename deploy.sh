#!/usr/bin/env bash
# One-command deploy for the SATE cloud services.
#
#   ./deploy.sh <target>
#
# Targets:
#   web           Web app  → Vercel (git subtree push to the webapp remote)
#   docs          Public docs → Cloudflare Pages (sate-docs.pages.dev)
#   docs-internal Private handbook → Cloudflare Pages (sate-docs-internal, Basic Auth)
#   status        Status/monitoring Worker → status-sate.long-cao.dev
#   test-form     Recorder test form Worker → test-sate.long-cao.dev
#   functions     Supabase edge functions (device-api, mint-plaud-token, finalize-session)
#   processor     cf-processor container Worker (needs Docker running)
#   all           Everything above except processor (run that one explicitly)
#   check         Just verify the prerequisites/logins, deploy nothing
#
# One-time prerequisites (per developer):
#   - Node 18+            (nvm/homebrew)
#   - wrangler login      (Cloudflare — for docs/status/test-form/processor)
#   - supabase login      (for edge functions)   +  supabase link --project-ref zlgdpivcbmaodgokkdvz
#   - a "webapp" git remote → the Vercel repo (Longcao24/SATE_hardwave)
#   - secrets already set on the Workers (RESULT_PASSWORD, HEALTH_ALERT_KEY, SUPA_ANON, SITE_PASSWORD)
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
WR="npx --yes wrangler@latest"
SUPA_REF="zlgdpivcbmaodgokkdvz"

c()  { printf "\033[1;36m▸ %s\033[0m\n" "$*"; }
ok() { printf "\033[1;32m✓ %s\033[0m\n" "$*"; }
die(){ printf "\033[1;31m✗ %s\033[0m\n" "$*" >&2; exit 1; }
have(){ command -v "$1" >/dev/null 2>&1; }

check_prereqs() {
  c "Checking prerequisites"
  have node || die "node not found — install Node 18+"
  have npx  || die "npx not found (comes with Node)"
  $WR whoami >/dev/null 2>&1 && ok "Cloudflare: logged in" || echo "  ! Cloudflare: not logged in (run: npx wrangler login) — needed for docs/status/test-form/processor"
  if have supabase; then
    supabase projects list >/dev/null 2>&1 && ok "Supabase: logged in" || echo "  ! Supabase: not logged in (run: supabase login) — needed for functions"
  else
    echo "  ! Supabase CLI not installed (brew install supabase/tap/supabase) — needed for functions"
  fi
  git remote | grep -qx webapp && ok "git 'webapp' remote present" || echo "  ! no 'webapp' git remote — needed for web deploy (git remote add webapp <url>)"
}

dep_web() {
  c "Web app → build check, then subtree push to Vercel"
  ( cd react_app_sate-ui_update && npm run build ) || die "web build failed (fix before pushing — Vercel would fail too)"
  git subtree push --prefix=react_app_sate-ui_update webapp main
  ok "web pushed (Vercel builds the subtree)"
}
dep_docs()          { c "Public docs → Cloudflare Pages"; ( cd docs-site && npm install --silent && npm run deploy:cf ); ok "docs deployed"; }
dep_docs_internal() { c "Private handbook → Cloudflare Pages"; ( cd docs-site-internal && npm run deploy:cf ); ok "internal docs deployed"; }
dep_status()        { c "Status worker → status-sate.long-cao.dev"; ( cd status && $WR deploy ); ok "status deployed"; }
dep_test_form()     { c "Test form worker → test-sate.long-cao.dev"; ( cd sate-test-form && $WR deploy ); ok "test-form deployed"; }
dep_functions() {
  c "Supabase edge functions (--no-verify-jwt is mandatory — they validate their own tokens)"
  for fn in device-api mint-plaud-token finalize-session; do
    supabase functions deploy "$fn" --no-verify-jwt --use-api --project-ref "$SUPA_REF" || echo "  ! $fn not deployed (may not exist locally — skipping)"
  done
  ok "functions deployed"
}
dep_processor() {
  have docker && docker info >/dev/null 2>&1 || die "Docker must be running to build the cf-processor container image"
  c "cf-processor container Worker"; ( cd cf-processor && npm install --silent && $WR deploy ); ok "processor deployed"
}

TARGET="${1:-}"
[ -z "$TARGET" ] && { grep -E '^#( |$)' "$0" | sed -E 's/^# ?//'; exit 0; }

check_prereqs
case "$TARGET" in
  web)           dep_web ;;
  docs)          dep_docs ;;
  docs-internal) dep_docs_internal ;;
  status)        dep_status ;;
  test-form)     dep_test_form ;;
  functions)     dep_functions ;;
  processor)     dep_processor ;;
  all)           dep_functions; dep_status; dep_test_form; dep_docs; dep_docs_internal; dep_web
                 echo; ok "ALL deployed (cf-processor excluded — run: ./deploy.sh processor)" ;;
  check)         ok "prerequisite check complete" ;;
  *)             die "unknown target '$TARGET' — run ./deploy.sh with no args to see the list" ;;
esac
