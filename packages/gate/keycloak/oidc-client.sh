#!/usr/bin/env bash
# Set up a Keycloak realm for the gate's "Sign in with …" (OpenID Connect). Idempotent: run it
# again to add a host or a group. For realm REALM it makes sure that:
#
#   - a confidential client CLIENT (default `observatory`) exists, with the standard
#     (authorization code + PKCE) flow only, and redirect URIs
#     <origin>/auth/oauth2/callback/<PROVIDER> for every origin in ORIGINS;
#   - the client puts the user's groups in its tokens: claim `groups`, full paths
#     (`/dashboards`), which the gate's access rules match;
#   - each group in GROUPS exists at the top level of the realm.
#
# It never prints the client secret. When deploying the gate, read it with
#   kcadm.sh get clients/<id>/client-secret -r REALM
# and store it as the Worker secret (wrangler secret put OIDC_<PROVIDER>_SECRET).
#
# Runs inside the Keycloak container (kcadm.sh; no jq there), e.g. on the ICR's VM:
#
#   gcloud … compute ssh icr-hapi --command='cd /opt/icr-hapi/gcp && sudo docker compose exec -T keycloak \
#     bash -s -- REALM ORIGINS [GROUPS] [PROVIDER] [CLIENT]' < oidc-client.sh
#
#   REALM     the realm, e.g. uga
#   ORIGINS   comma-separated gate origins, e.g. https://dashboards.healthcampaigns.org,http://localhost:8787
#   GROUPS    comma-separated group names to create (default: dashboards)
#   PROVIDER  the provider id in the gate's config (default: REALM)
#   CLIENT    the client id (default: observatory)
set -euo pipefail
K=/opt/keycloak/bin/kcadm.sh
REALM=${1:?realm}; ORIGINS=${2:?origins}; GROUP_NAMES=${3:-dashboards}; PROVIDER=${4:-$REALM}; CLIENT=${5:-observatory}

$K config credentials --server http://localhost:8080 --realm master \
  --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" >/dev/null 2>&1
$K get "realms/$REALM" >/dev/null 2>&1 || { echo "no realm $REALM" >&2; exit 1; }

# JSON arrays of the redirect URIs and web origins.
redirects=""; origins=""
IFS=, read -ra list <<< "$ORIGINS"
for o in "${list[@]}"; do
  o=${o%/}
  redirects="$redirects${redirects:+,}\"$o/auth/oauth2/callback/$PROVIDER\""
  origins="$origins${origins:+,}\"$o\""
done

client_id() {
  $K get clients -r "$REALM" -q "clientId=$CLIENT" --fields id,clientId 2>/dev/null \
    | tr -d '\n ' | grep -o "\"id\":\"[^\"]*\",\"clientId\":\"$CLIENT\"" | cut -d'"' -f4 || true
}

id=$(client_id)
settings=(-s enabled=true -s publicClient=false -s standardFlowEnabled=true
  -s directAccessGrantsEnabled=false -s implicitFlowEnabled=false -s serviceAccountsEnabled=false
  -s "redirectUris=[$redirects]" -s "webOrigins=[$origins]"
  -s 'attributes."pkce.code.challenge.method"=S256')
if [ -z "$id" ]; then
  id=$($K create clients -r "$REALM" -i -s "clientId=$CLIENT" -s "name=Observatory dashboards" "${settings[@]}")
  echo "client $CLIENT created in $REALM"
else
  $K update "clients/$id" -r "$REALM" "${settings[@]}"
  echo "client $CLIENT updated in $REALM"
fi

# The groups claim, with full paths, in the ID token, access token and userinfo.
if ! $K get "clients/$id/protocol-mappers/models" -r "$REALM" --fields name | tr -d '\n ' | grep -q '"name":"groups"'; then
  $K create "clients/$id/protocol-mappers/models" -r "$REALM" -s name=groups -s protocol=openid-connect \
    -s protocolMapper=oidc-group-membership-mapper -s 'config."claim.name"=groups' -s 'config."full.path"=true' \
    -s 'config."id.token.claim"=true' -s 'config."access.token.claim"=true' -s 'config."userinfo.token.claim"=true' >/dev/null
  echo "mapper groups added"
fi

IFS=, read -ra glist <<< "$GROUP_NAMES"
for g in "${glist[@]}"; do
  if $K get groups -r "$REALM" --fields name | tr -d '\n ' | grep -q "\"name\":\"$g\""; then
    echo "group /$g exists"
  else
    $K create groups -r "$REALM" -s "name=$g" >/dev/null && echo "group /$g created"
  fi
done

echo "redirect URIs: [$redirects]"
echo "issuer: <keycloak host>/realms/$REALM   client: $CLIENT   provider id: $PROVIDER"
