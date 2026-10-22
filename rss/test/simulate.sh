#!/usr/bin/env bash
# Runs the generator twice against the live sheet in a temp dir, edits the
# snapshot to fake a set of changes, runs again, and validates the XML.
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
node generate.js --state "$T/state" --out "$T/feed.xml"
python3 -c "import sys,xml.dom.minidom as m;m.parse(sys.argv[1]);print('feed.xml is well-formed XML')" "$T/feed.xml"
echo "Output in $T"
