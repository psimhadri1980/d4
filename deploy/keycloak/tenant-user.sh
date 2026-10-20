#!/usr/bin/env bash
# Local Keycloak: makes the `tenant` token claim come from a per-user attribute (instead of the
# hard-coded t_local), then creates or updates a dev user for a tenant. Safe to re-run.
#   tenant-user.sh <tenant> <username> [realm-role ...]      (default role: admin; password d4-local-dev)
set -euo pipefail
tenant="${1:?tenant}"; user="${2:?username}"; shift 2
roles=("${@:-admin}")
kc() { docker exec d4-keycloak-1 /opt/keycloak/bin/kcadm.sh "$@"; }
kc config credentials --server http://localhost:8080 --realm master --user admin --password d4-local-dev >/dev/null

# 1. Declare `tenant` in the user profile: only admins can see or change it (users cannot move
#    themselves to another tenant), and Keycloak 25 drops undeclared attributes.
profile=$(kc get users/profile -r d4)
if ! grep -q '"name" *: *"tenant"' <<<"$profile"; then
  python3 -c "$(cat <<'PY'
import json, sys
p = json.loads(sys.argv[1])
p["attributes"].append({"name": "tenant", "displayName": "Tenant", "permissions": {"view": ["admin"], "edit": ["admin"]}, "multivalued": False})
print(json.dumps(p))
PY
)" "$profile" | docker exec -i d4-keycloak-1 /opt/keycloak/bin/kcadm.sh update users/profile -r d4 -f -
  echo "Declared the tenant attribute."
fi

# 2. Existing users without a tenant belong to the local tenant (before the claim mapper changes).
for id in $(kc get users -r d4 --fields id,attributes | python3 -c 'import json,sys; print(" ".join(u["id"] for u in json.load(sys.stdin) if "tenant" not in (u.get("attributes") or {})))'); do
  kc update "users/$id" -r d4 -s 'attributes.tenant=["t_local"]'
done

# 3. The `tenant` claim comes from the user attribute.
cid=$(kc get clients -r d4 -q clientId=d4-web --fields id --format csv --noquotes)
mappers=$(kc get "clients/$cid/protocol-mappers/models" -r d4 --fields id,name,protocolMapper --format csv --noquotes)
if grep -q ',tenant,oidc-hardcoded-claim-mapper' <<<"$mappers"; then
  kc delete "clients/$cid/protocol-mappers/models/$(grep ',tenant,oidc-hardcoded-claim-mapper' <<<"$mappers" | cut -d, -f1)" -r d4
  kc create "clients/$cid/protocol-mappers/models" -r d4 -s name=tenant -s protocol=openid-connect -s protocolMapper=oidc-usermodel-attribute-mapper \
    -s 'config."user.attribute"=tenant' -s 'config."claim.name"=tenant' -s 'config."jsonType.label"=String' \
    -s 'config."access.token.claim"=true' -s 'config."id.token.claim"=false' -s 'config."userinfo.token.claim"=false' >/dev/null
  echo "The tenant claim now comes from the user's tenant attribute."
fi

# 4. The user.
uid=$(kc get users -r d4 -q "username=$user" -q exact=true --fields id --format csv --noquotes)
if [[ -z "$uid" ]]; then
  kc create users -r d4 -s "username=$user" -s "email=$user@d4.localhost" -s emailVerified=true -s enabled=true \
    -s firstName=Dev -s "lastName=$tenant" -s "attributes.tenant=[\"$tenant\"]" >/dev/null
  kc set-password -r d4 --username "$user" --new-password d4-local-dev
  echo "Created $user (password d4-local-dev)."
else
  kc update "users/$uid" -r d4 -s "attributes.tenant=[\"$tenant\"]"
fi
for r in "${roles[@]}"; do kc add-roles -r d4 --uusername "$user" --rolename "$r"; done
echo "$user belongs to $tenant with roles: ${roles[*]}"
