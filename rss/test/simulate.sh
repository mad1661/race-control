#!/usr/bin/env bash
# Runs the generator twice against the live sheet in a temp dir, edits the
# snapshot to fake a set of changes, runs again, and validates the XML.
# A follow-up note-only edit must not publish an item or rewrite state.
set -euo pipefail
cd "$(dirname "$0")/.."
T=$(mktemp -d)
node generate.js --state "$T/state" --out "$T/feed.xml"
node generate.js --state "$T/state" --out "$T/feed.xml"
python3 - "$T/state/snapshot.json" <<'PY'
import json,sys
p=sys.argv[1];d=json.load(open(p));D={x['label']:x for x in d['days']}
fri=D['Day 2']['items'];sat=D['Day 3']['items']
fri[0]['scheduled']='7:45 AM'
fri[3]['round']='TT-1'
fri[2]['note']='Moved up two pairs'
sat.insert(4,{'scheduled':'','name':'Jr. Dragster Exhibition','round':'','note':''})
del sat[7]
D['Day 4']['items']=[]
json.dump(d,open(p,'w'),indent=2)
PY
before=$(python3 -c "import json,sys; print(len(json.load(open(sys.argv[1]))))" "$T/state/items.json")
order_out=$(node generate.js --state "$T/state" --out "$T/feed.xml")
printf '%s\n' "$order_out"
python3 - "$T/state/items.json" "$before" "$order_out" <<'PY'
import json, sys
items = json.load(open(sys.argv[1]))
before = int(sys.argv[2])
stdout = sys.argv[3]
fresh = items[:len(items) - before]
text = stdout + "\n" + "\n".join(i["title"] + "\n" + i["description"] for i in fresh)
required = ["7:45 AM", "Time Trial 1", "Jr. Dragster Exhibition", "removed"]
missing = [s for s in required if s not in text]
banned = ["Moved up two pairs", "note added", "note changed", "note removed"]
hit = [s for s in banned if s in text]
if not fresh or missing or hit:
    raise SystemExit(f"run-order diff mismatch\nfresh={len(fresh)}\nmissing={missing}\nhit={hit}\n{text}")
print(f"run-order edits produced {len(fresh)} item(s); the planted note did not")
PY
python3 -c "import sys,xml.dom.minidom as m;m.parse(sys.argv[1]);print('feed.xml is well-formed XML')" "$T/feed.xml"

# Note-only: the live sheet is back in the snapshot. Changing a note must be silent.
cp "$T/state/items.json" "$T/items.noted"
cp "$T/feed.xml" "$T/feed.noted"
python3 - "$T/state/snapshot.json" <<'PY'
import json,sys
p=sys.argv[1];d=json.load(open(p))
day=next(x for x in d['days'] if x['items'])
day['items'][0]['note']='Ops comment only'
json.dump(d,open(p,'w'),indent=2)
print('planted note on', day['label'], day['items'][0]['name'])
PY
cp "$T/state/snapshot.json" "$T/snapshot.noted"
note_out=$(node generate.js --state "$T/state" --out "$T/feed.xml")
printf '%s\n' "$note_out"
[[ "$note_out" == *"No changes."* ]] || { echo "note-only edit was not silent: $note_out"; exit 1; }
cmp "$T/state/snapshot.json" "$T/snapshot.noted"
cmp "$T/state/items.json" "$T/items.noted"
cmp "$T/feed.xml" "$T/feed.noted"
echo "note-only edit left the feed, items, and snapshot unchanged"
echo "Output in $T"
