"""Verify the frozen SPEC-007 app with isolated data after the user app stops."""
import hashlib
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from urllib.request import Request, urlopen

DEV = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('BDO_EVIDENCE_DIR', str(DEV / 'specs/007-feature-restoration/evidence')))
OUT.mkdir(parents=True, exist_ok=True)
EXE = Path(os.environ.get('BDO_PACKAGE_APP', str(DEV.parent / '업데이트_검증판/app'))) / 'BDO 물교 실행.exe'
BASE = 'http://127.0.0.1:18765'
TEMP = Path(tempfile.mkdtemp(prefix='BDO-Restoration-Frozen-'))
PROFILE = TEMP / 'chrome'
env = os.environ.copy()
env['LOCALAPPDATA'] = str(TEMP / 'data')
env['PATH'] = str(Path(os.environ['SystemRoot']) / 'System32')
for key in ('PYTHONHOME', 'PYTHONPATH'):
    env.pop(key, None)
env['BROWSER'] = f'"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --headless=new --no-sandbox --disable-gpu --no-first-run --disable-background-networking --remote-debugging-port=0 --user-data-dir="{PROFILE}" %s &'
startup = subprocess.STARTUPINFO()
startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
startup.wShowWindow = 0


def request(path, body=None, method=None):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode('utf-8')
    req = Request(BASE + path, data=data, method=method,
                  headers={'Content-Type': 'application/json', 'Origin': BASE})
    with urlopen(req, timeout=20) as response:
        return json.loads(response.read())


def healthy():
    try:
        return request('/api/health').get('ok') is True
    except OSError:
        return False


def wait(predicate, label):
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(.1)
    raise RuntimeError('Timed out: ' + label)


def start():
    global process
    assert not healthy(), 'Refusing to use an existing listener'
    process = subprocess.Popen([str(EXE)], cwd=TEMP, env=env, startupinfo=startup)
    wait(healthy, 'frozen app health')
    assert request('/api/health')['schemaVersion'] == 3
    wait(lambda: (PROFILE / 'DevToolsActivePort').exists(), 'automatic Chrome launch')
    wait(browser_loaded, 'packaged browser UI loaded with 70 inventory rows')
    return process


def browser_loaded():
    port = (PROFILE / 'DevToolsActivePort').read_text().splitlines()[0]
    js = """
const targets=await fetch('http://127.0.0.1:'+process.argv[1]+'/json/list').then(r=>r.json());
const t=targets.find(t=>t.url==='http://127.0.0.1:18765/');if(!t)process.exit(1);
const w=new WebSocket(t.webSocketDebuggerUrl);await new Promise(r=>w.onopen=r);
const result=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('CDP timeout')),5000);w.onmessage=e=>{const m=JSON.parse(e.data);if(m.id===1){clearTimeout(timer);resolve(m)}}});
w.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:"({url:location.href,rows:document.querySelectorAll('.inventory-row').length,busy:document.querySelector('#app-content')?.getAttribute('aria-busy')})",returnByValue:true}}));
console.log(JSON.stringify(await result));w.close();
"""
    result = subprocess.run([r'C:\Program Files\nodejs\node.exe', '--input-type=module', '-e', js, port],
                            capture_output=True, text=True, encoding='utf-8', timeout=10, startupinfo=startup)
    if result.returncode:
        return False
    value = json.loads(result.stdout).get('result', {}).get('result', {}).get('value', {})
    return value.get('rows') == 70 and value.get('busy') == 'false'


def stop(process):
    request('/api/app/shutdown', {})
    wait(lambda: not healthy(), 'graceful shutdown')
    process.wait(timeout=20)


sequence = 0


def mutate(path, payload, method):
    global sequence
    sequence += 1
    body = {'mutationId': f'frozen007-{sequence}', 'baseRevision': request('/api/bootstrap')['revision'], **payload}
    return request(path, body, method)


with socket.socket() as probe:
    probe.bind(('127.0.0.1', 18765))
process = None
try:
    process = start()
    boot = request('/api/bootstrap')
    assert len(boot['inventory']) == 70
    fixture = DEV / 'fixtures/warehouse_patch/barter_only.png'
    boundary = 'bdo-restoration-frozen-fixture'
    upload = (f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="barter_only.png"\r\nContent-Type: image/png\r\n\r\n'.encode()
              + fixture.read_bytes() + f'\r\n--{boundary}--\r\n'.encode())
    req = Request(BASE + '/api/warehouse-scan', data=upload,
                  headers={'Origin': BASE, 'Content-Type': 'multipart/form-data; boundary=' + boundary})
    with urlopen(req, timeout=120) as response:
        scanned = json.load(response)
    sys.path.insert(0, str(DEV))
    from tools.warehouse_patch.warehouse_patch import convert
    expected_patch, expected_report = convert(fixture, DEV / 'reference/barter_items.json',
                                              DEV / 'tools/warehouse_patch/quantity_templates.npz')
    assert scanned['patch'] == expected_patch
    assert [row['decision'] for row in scanned['report']['slots']] == [row['decision'] for row in expected_report['slots']]
    assert request('/api/bootstrap') == boot, 'Scanner changed inventory/session before Apply'
    feedback_rows = [{'slot': slot['slot'], 'name': None, 'quantity': None, 'excluded': True, 'itemCheck': 'unchecked'}
                     for slot in scanned['report']['slots'] if slot['decision'] not in {'MATCH', 'EMPTY', 'TIER5_IGNORE'}]
    mutate('/api/inventory', {'kind': 'warehouse', 'patch': scanned['patch'], 'feedback': {'scanId': scanned['report']['scanId'], 'rows': feedback_rows}}, 'PATCH')
    import io
    import zipfile
    with urlopen(BASE + '/api/warehouse-dataset', timeout=60) as response:
        with zipfile.ZipFile(io.BytesIO(response.read())) as archive:
            assert json.loads(archive.read('manifest.json'))['scanCount'] == 1
            assert archive.read(f"scans/{scanned['report']['scanId']}/input.png") == fixture.read_bytes()
            samples = [json.loads(line) for line in archive.read('samples.jsonl').splitlines()]
            assert len(samples) == len(scanned['report']['slots'])
            assert not any(label['verifiedItemLabel'] for sample in samples for label in sample['humanFeedback'])
    name = boot['inventory'][0]['programName']
    mutate('/api/inventory', {'kind': 'manual', 'patch': {'items': {name: {'stock': 43}}}}, 'PATCH')
    session = {
        'version': 1, 'id': 'frozen-session',
        'scannedTrades': [{'island': '테스트 섬', 'fromItem': name, 'toItem': name, 'reqAmount': 1, 'count': 1, 'yield': 1}],
        'schedule': {'speed': [{'trades': [{'island': '테스트 섬', 'originalIndex': 0}]}], 'balance': []},
        'completed': None, 'remainingParley': 123456,
        'config': {key: boot['settings'][key] for key in ('ship', 'parley', 'tuning')},
        'selection': {'briefMode': 'both', 'selectedScheduleSlot': 2},
        'diagnostics': {'generatedAt': 123, 'engineDebug': {'reason': 'frozen runtime test'}},
    }
    mutate('/api/working-session', {'session': session}, 'PUT')
    mutate('/api/schedule-slots/2', {'snapshot': {'version': 1, 'createdAt': 456, 'session': session}}, 'PUT')
    before = request('/api/bootstrap')
    stop(process)
    process = start()
    after = request('/api/bootstrap')
    assert after['workingSession'] == session
    assert after['scheduleSlots']['2'] == before['scheduleSlots']['2']
    assert next(row for row in after['inventory'] if row['programName'] == name)['stock'] == 43
    completed = json.loads(json.dumps(session))
    completed['remainingParley'] -= 1
    body = {'mutationId': 'frozen007-completion', 'baseRevision': after['revision'],
            'kind': 'completion', 'patch': {'items': {}}, 'session': completed,
            'sessionRevision': after['sessionRevision']}
    first = request('/api/working-session/completion', body, 'POST')
    replay = request('/api/working-session/completion', body, 'POST')
    assert replay['idempotent'] is True and replay['revision'] == first['revision']
    assert request('/api/bootstrap')['workingSession'] == completed
    mutate('/api/working-session', {}, 'DELETE')
    reset = request('/api/bootstrap')
    assert reset['workingSession'] is None
    assert reset['inventory'] == after['inventory'] and reset['settings'] == after['settings']
    assert reset['scheduleSlots'] == after['scheduleSlots']
    database = Path(env['LOCALAPPDATA']) / 'BDOBarter/data/bdo.sqlite3'
    with sqlite3.connect(database) as db:
        tables = sorted(row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'"))
    assert tables == ['app_meta', 'inventory', 'mutation_receipt', 'saved_schedule_slot', 'settings', 'warehouse_feedback', 'warehouse_scan', 'working_session']
    result = {'ok': True, 'schemaVersion': 3, 'inventoryRows': 70, 'tables': tables,
              'processRestartRestoredWorkingAndSlot': True, 'resetPreservedDurableAndSlot': True,
              'completionEndpointAndExactReplay': True,
              'packagedScannerMatchesProtectedConvert': True,
              'packagedFeedbackAndDatasetExport': True,
              'automaticChromeLaunch': True, 'pythonRemovedFromPath': True,
              'packagedBrowserUiInventoryRows': 70,
              'actualUserDatabaseTouched': False, 'exeSha256': hashlib.sha256(EXE.read_bytes()).hexdigest()}
    (OUT / 'packaged-runtime.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=True), flush=True)
finally:
    if process is not None and healthy():
        stop(process)
    # Close only the isolated Chrome browser opened by this test.
    if (PROFILE / 'DevToolsActivePort').exists():
        port = (PROFILE / 'DevToolsActivePort').read_text().splitlines()[0]
        js = "const d=await fetch('http://127.0.0.1:'+process.argv[1]+'/json/version').then(r=>r.json());const w=new WebSocket(d.webSocketDebuggerUrl);await new Promise(r=>w.onopen=r);w.send(JSON.stringify({id:1,method:'Browser.close'}));await new Promise(r=>w.onclose=r);"
        subprocess.run([r'C:\Program Files\nodejs\node.exe', '--input-type=module', '-e', js, port],
                       capture_output=True, timeout=20, startupinfo=startup)
