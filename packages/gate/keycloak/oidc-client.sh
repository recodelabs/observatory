#!/usr/bin/env bash
# Set up a Keycloak realm for the gate's "Sign in with …" (OpenID Connect). Idempotent: run it
# again to add a host or a group, or to repair the settings. For realm REALM it makes sure that:
#
#   - a confidential client CLIENT (default `observatory`) exists, with the standard
#     (authorization code + PKCE S256) flow only, and the redirect URI
#     <origin>/auth/callback/<PROVIDER> for every origin in ORIGINS (Better Auth's OAuth
#     callback, under the gate's /auth base path);
#   - the client's tokens carry the user's groups (claim `groups`, full paths such as
#     `/dashboards`) and realm roles (claim `realm_roles`), in the ID token, access token and
#     userinfo, which the gate's access rules match; existing mappers of those names are
#     brought back to these settings;
#   - each group in GROUPS exists at the top level of the realm.
#
# It never prints the client secret. When deploying the gate, read it with
#   kcadm.sh get clients/<id>/client-secret -r REALM
# and store it as the Worker secret (wrangler secret put OIDC_<PROVIDER>_SECRET).
#
# Runs inside the Keycloak container (kcadm.sh; no jq or awk there), e.g. on the ICR's VM:
#
#   gcloud … compute ssh icr-hapi --command='cd /opt/icr-hapi/gcp && sudo docker compose exec -T keycloak \
#     bash -s -- REALM ORIGINS [GROUPS] [PROVIDER] [CLIENT]' < oidc-client.sh
#
#   REALM     the realm, e.g. uga
#   ORIGINS   comma-separated gate origins, e.g. https://dashboards.healthcampaigns.org,http://localhost:8787
#   GROUPS    comma-separated group names to create (default: dashboards)
#   PROVIDER  the provider id in the gate's config (default: REALM)
#   CLIENT    the client id (default: observatory)
#
# Inputs are checked against a strict grammar (names: letters, digits, _ and -; origins:
# http(s)://host[:port]), so the JSON this script builds needs no escaping, and names are
# compared exactly (never as patterns).
set -euo pipefail
K=/opt/keycloak/bin/kcadm.sh
REALM=${1:?realm}; ORIGINS=${2:?origins}; GROUP_NAMES=${3:-dashboards}; PROVIDER=${4:-$REALM}; CLIENT=${5:-observatory}

name_ok() { [[ "$1" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || { echo "invalid name: $1 (letters, digits, _ and -)" >&2; exit 2; }; }
name_ok "$REALM"; name_ok "$PROVIDER"; name_ok "$CLIENT"

# The redirect URIs and web origins, as JSON arrays.
redirects=""; origins=""
IFS=, read -ra list <<< "$ORIGINS"
for o in "${list[@]}"; do
  o=${o%/}
  [[ "$o" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] || { echo "invalid origin: $o (http(s)://host[:port])" >&2; exit 2; }
  redirects="$redirects${redirects:+,}\"$o/auth/callback/$PROVIDER\""
  origins="$origins${origins:+,}\"$o\""
done
IFS=, read -ra glist <<< "$GROUP_NAMES"
for g in "${glist[@]}"; do name_ok "$g"; done

$K config credentials --server http://localhost:8080 --realm master \
  --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" >/dev/null 2>&1
$K get "realms/$REALM" >/dev/null 2>&1 || { echo "no realm $REALM" >&2; exit 1; }

# get_id PATH FIELD VALUE: the id of the object at PATH whose FIELD equals VALUE exactly;
# nothing when there is none. A failed read stops the script (it is not taken as "none").
get_id() {
  local rows a b
  if ! rows=$($K get "$1" -r "$REALM" --fields "id,$2" --format csv --noquotes); then
    echo "reading $1 in $REALM failed" >&2; exit 1
  fi
  while IFS=, read -r a b; do
    if [ "$b" = "$3" ]; then echo "$a"; return; fi
  done <<< "$rows"
}

id=$(get_id clients clientId "$CLIENT") || exit 1
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

# mapper NAME TYPE CLAIM [extra -s settings…]: create the protocol mapper, or bring an existing
# one of that name back to these settings.
mapper() {
  local name=$1 type=$2 claim=$3; shift 3
  local cfg=(-s "name=$name" -s protocol=openid-connect -s "protocolMapper=$type"
    -s "config.\"claim.name\"=$claim" -s 'config."id.token.claim"=true' -s 'config."access.token.claim"=true'
    -s 'config."userinfo.token.claim"=true' "$@")
  local mid; mid=$(get_id "clients/$id/protocol-mappers/models" name "$name") || exit 1
  if [ -z "$mid" ]; then
    $K create "clients/$id/protocol-mappers/models" -r "$REALM" "${cfg[@]}" >/dev/null
    echo "mapper $name added"
  else
    $K update "clients/$id/protocol-mappers/models/$mid" -r "$REALM" -s "id=$mid" "${cfg[@]}"
    echo "mapper $name checked"
  fi
}
mapper groups oidc-group-membership-mapper groups -s 'config."full.path"=true'
mapper realm_roles oidc-usermodel-realm-role-mapper realm_roles -s 'config.multivalued=true' -s 'config."jsonType.label"=String'

for g in "${glist[@]}"; do
  gid=$(get_id groups name "$g") || exit 1
  if [ -n "$gid" ]; then
    echo "group /$g exists"
  else
    if ! $K create groups -r "$REALM" -s "name=$g" >/dev/null; then
      echo "creating group /$g in $REALM failed" >&2; exit 1
    fi
    echo "group /$g created"
  fi
done

echo "redirect URIs: [$redirects]"
echo "issuer: <keycloak host>/realms/$REALM   client: $CLIENT   provider id: $PROVIDER"
