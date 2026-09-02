#!/usr/bin/env bash

set -euo pipefail

certificate_path="${1:-}"
repository="${2:-}"

if [[ -z "$certificate_path" || ! -f "$certificate_path" ]]; then
  echo "Usage: $0 /absolute/path/to/developer-id-application.p12 [owner/repository]"
  exit 1
fi

if [[ -z "$repository" ]]; then
  repository="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
fi

gh auth status >/dev/null

read -r -p "Apple ID email: " apple_id
read -r -p "Apple Team ID: " apple_team_id
read -r -s -p "Certificate export password: " certificate_password
printf '\n'
read -r -s -p "Apple app-specific password: " apple_password
printf '\n'

if [[ -z "$apple_id" || -z "$apple_team_id" || -z "$certificate_password" || -z "$apple_password" ]]; then
  echo "Every value is required."
  exit 1
fi

printf '%s\n' "$certificate_password" | openssl pkcs12 -in "$certificate_path" -noout -passin stdin

keychain_password="$(openssl rand -base64 32)"

openssl base64 -A -in "$certificate_path" | gh secret set APPLE_CERTIFICATE --repo "$repository"
printf '%s' "$certificate_password" | gh secret set APPLE_CERTIFICATE_PASSWORD --repo "$repository"
printf '%s' "$keychain_password" | gh secret set APPLE_KEYCHAIN_PASSWORD --repo "$repository"
printf '%s' "$apple_id" | gh secret set APPLE_ID --repo "$repository"
printf '%s' "$apple_password" | gh secret set APPLE_PASSWORD --repo "$repository"
printf '%s' "$apple_team_id" | gh secret set APPLE_TEAM_ID --repo "$repository"

unset certificate_password keychain_password apple_password

echo "Apple signing and notarization secrets configured for $repository."
