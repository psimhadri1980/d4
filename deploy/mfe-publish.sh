#!/usr/bin/env bash
# Uploads a web module build as an immutable release (D70) and, with --activate, points the
# tenant's registry at it. Rolling back is --activate with an older, already uploaded version.
#   deploy/mfe-publish.sh <name> <dist-dir> <version> [--activate] [--title T] [--framework react|vanilla|other] [--entry file.js]
source "$(dirname "$0")/lib/common.sh"

name="${1:-}"; dist="${2:-}"; version="${3:-}"
[[ -n "$name" && -n "$version" ]] || die "usage: deploy/mfe-publish.sh <name> <dist-dir> <version> [--activate] [--title T] [--framework F] [--entry file.js]" 2
shift 3
activate=0; title="$name"; framework=react; entry="$name.js"
while (( $# )); do
  case "$1" in
    --activate) activate=1 ;; --title) title="$2"; shift ;; --framework) framework="$2"; shift ;; --entry) entry="$2"; shift ;;
    *) die "unknown option $1" 2 ;;
  esac
  shift
done
[[ "$dist" = /* ]] || dist="$(cd .. && pwd)/$dist"
api="$D4_PUBLIC_API_URL/v1/admin/web-modules/$name"
token=$(./dev-infra.sh token)
auth=(-H "Authorization: Bearer $token" -H 'Content-Type: application/json')

if [[ -d "$dist" ]]; then
  body=$(node - "$dist" "$name" "$version" "$entry" "$framework" <<'JS'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const [dir, name, version, entry, framework] = process.argv.slice(2);
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const manifest = { name, version, contract: 2, entry, framework, files: {} }, files = {};
for (const f of walk(dir)) {
  const rel = path.relative(dir, f).split(path.sep).join('/');
  if (rel === 'manifest.json') continue;
  const buf = fs.readFileSync(f);
  manifest.files[rel] = crypto.createHash('sha256').update(buf).digest('hex');
  files[rel] = buf.toString('base64');
}
process.stdout.write(JSON.stringify({ manifest, files }));
JS
)
  out=$(curl -sS -w '\n%{http_code}' -X POST "${auth[@]}" --data-binary @- "$api/releases" <<<"$body")
  code=${out##*$'\n'}; out=${out%$'\n'*}
  case "$code" in
    201) say "Released $name $version" ;;
    409) say "$name $version is already released; using it" ;;
    *) die "Release failed ($code): $out" ;;
  esac
fi

if (( activate )); then
  # The registry entry for an uploaded release follows from the tenant, name and version.
  tenant=$(curl -fsS -H "Authorization: Bearer $token" "$D4_PUBLIC_API_URL/v1/me" | node -pe 'JSON.parse(require("fs").readFileSync(0)).tenantId')
  put=$(printf '{"title":"%s","entry":"/mfe/_r/%s/%s/%s/%s","version":"%s","contract":2,"framework":"%s"}' "$title" "$tenant" "$name" "$version" "$entry" "$version" "$framework")
  curl -fsS -X PUT "${auth[@]}" -d "$put" "$api" >/dev/null || die "Activation failed"
  say "Activated $name $version for tenant $tenant"
fi
