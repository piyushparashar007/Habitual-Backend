#!/usr/bin/env bash
# populate_demo.sh — seed demo data + 7-day history into Activityual backend using curl only.
# Usage: ./populate_demo.sh [base_url]
# Requirements: curl, jq, python3

set -euo pipefail

BASE_URL="${1:-http://localhost:3002}"
echo "=== 🌱 Seeding demo data into $BASE_URL ==="

post_json() {
  local url="$1"; local json="$2"
  curl -s -X POST "$url" -H "Content-Type: application/json" -d "$json"
}

EMAIL="piyushnagptest@example.com"
PASSWORD="demo1234"
NAME="Piyush Parashar"

echo "→ Creating demo user ($EMAIL)..."
signup_resp=$(post_json "$BASE_URL/signup" "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"name\":\"$NAME\"}" || echo "")
token=$(echo "$signup_resp" | jq -r '.token // empty' 2>/dev/null || echo "")
user_id=$(echo "$signup_resp" | jq -r '.user.id // empty' 2>/dev/null || echo "")

if [[ -z "$token" ]]; then
  echo "ℹ️  Signup may already exist — attempting login..."
  login_resp=$(post_json "$BASE_URL/login" "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" || echo "")
  token=$(echo "$login_resp" | jq -r '.token // empty' 2>/dev/null || echo "")
  user_id=$(echo "$login_resp" | jq -r '.user.id // empty' 2>/dev/null || echo "")
fi

if [[ -z "$token" ]]; then
  echo "❌ Failed to create or login demo user. Response:"
  echo "$signup_resp"
  exit 1
fi

echo "✅ Authenticated! User ID: $user_id"
echo "🔑 Token (truncated): ${token:0:32}..."

create_activity() {
  local title="$1" notes="$2" frequency="$3" category="$4"
  resp=$(curl -s -X POST "$BASE_URL/activities" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -d "{\"title\":\"$title\",\"notes\":\"$notes\",\"frequency\":\"$frequency\",\"category\":\"$category\"}")
  echo "$resp"
}

echo "→ Creating demo activities..."
a1_resp=$(create_activity "Read 20 pages" "Reading habit" "daily" "learning")
a2_resp=$(create_activity "Workout" "Gym or run" "3xweek" "health")
a3_resp=$(create_activity "Meditate" "10 minutes" "daily" "wellness")

A1=$(echo "$a1_resp" | jq -r '.id // empty')
A2=$(echo "$a2_resp" | jq -r '.id // empty')
A3=$(echo "$a3_resp" | jq -r '.id // empty')

echo "📝 Created activities:"
echo "  $A1 — Read 20 pages"
echo "  $A2 — Workout"
echo "  $A3 — Meditate"

if [[ -z "$A1" ]]; then
  list_resp=$(curl -s -X GET "$BASE_URL/activities" -H "Authorization: Bearer $token")
  A1=$(echo "$list_resp" | jq -r '.[] | select(.title=="Read 20 pages") | .id' | head -n1 || echo "")
  A2=$(echo "$list_resp" | jq -r '.[] | select(.title=="Workout") | .id' | head -n1 || echo "")
  A3=$(echo "$list_resp" | jq -r '.[] | select(.title=="Meditate") | .id' | head -n1 || echo "")
fi

# compute ISO date (N days ago) using python3 (argument passed to python)
date_iso_days_ago() {
  local days="$1"
  python3 - "$days" <<'PY'
import datetime,sys
days = int(sys.argv[1])
d = datetime.date.today() - datetime.timedelta(days=days)
print(d.isoformat())
PY
}

create_log() {
  local aid="$1" date="$2" status="$3"
  curl -s -X POST "$BASE_URL/activities/${aid}/log" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -d "{\"date\":\"$date\",\"status\":\"$status\"}" >/dev/null
}

echo "→ Creating 7-day history for each activity (today .. 6 days ago)..."

for A in "$A1" "$A2" "$A3"; do
  if [[ -z "$A" ]]; then
    echo "⚠️ Skipping empty activity id"
    continue
  fi
  for i in $(seq 0 6); do
    D=$(date_iso_days_ago "$i")
    if (( i % 3 == 0 )); then
      S="missed"
    else
      S="done"
    fi
    create_log "$A" "$D" "$S"
  done
done

echo "📅 7-day logs created."

echo "→ Fetching analytics summary..."
analytics=$(curl -s -X GET "$BASE_URL/analytics/$user_id" -H "Authorization: Bearer $token")
echo "$analytics" | jq '.perActivity | map({title: .activity.title, doneCount, missedCount, consistency, streak})'

cat <<EOF

✅ Demo setup complete!
Credentials:

  Email:    $EMAIL
  Password: $PASSWORD
  User ID:  $user_id
  Base URL: $BASE_URL

You can inspect activities:
  curl -s -X GET "$BASE_URL/activities" -H "Authorization: Bearer $token" | jq

EOF

