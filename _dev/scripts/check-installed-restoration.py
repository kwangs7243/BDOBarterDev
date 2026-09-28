"""Record durable-data hashes around the explicitly approved package replacement."""
import hashlib
import json
from pathlib import Path
import sys
from urllib.request import urlopen

OUT = Path(__file__).resolve().parents[1] / 'specs/007-feature-restoration/evidence'
BASE = 'http://127.0.0.1:18765'
with urlopen(BASE + '/api/bootstrap', timeout=20) as response:
    boot = json.load(response)
with urlopen(BASE + '/api/health', timeout=20) as response:
    health = json.load(response)
assert health.get('service') == 'bdo-barter-local' and health.get('ok') is True
hashes = {key: hashlib.sha256(json.dumps(boot[key], ensure_ascii=False, sort_keys=True,
            separators=(',', ':')).encode('utf-8')).hexdigest() for key in ('inventory', 'order', 'settings')}
if sys.argv[1:] == ['before']:
    assert health['schemaVersion'] == 1, 'Expected the approved running old app'
    result = {'schemaVersion': health['schemaVersion'], 'revision': boot['revision'],
              'durableHashes': hashes, 'inventoryRows': len(boot['inventory'])}
    (OUT / 'installed-before.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
elif sys.argv[1:] == ['after']:
    before = json.loads((OUT / 'installed-before.json').read_text(encoding='utf-8'))
    assert health['schemaVersion'] == 2, health
    assert hashes == before['durableHashes'], 'Existing durable values changed during migration'
    assert boot['revision'] == before['revision'], 'Data revision unexpectedly changed'
    assert boot['workingSession'] is None
    assert all(value is None for value in boot['scheduleSlots'].values())
    result = {'ok': True, 'schemaBefore': before['schemaVersion'], 'schemaAfter': 2,
              'revision': boot['revision'], 'inventoryRows': len(boot['inventory']),
              'inventoryOrderSettingsPreserved': True, 'initialWorkingSession': None,
              'initialSlotsEmpty': True, 'health': health}
    (OUT / 'installed-upgrade.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
else:
    raise SystemExit('Usage: check-installed-restoration.py before|after')
print(json.dumps(result), flush=True)
