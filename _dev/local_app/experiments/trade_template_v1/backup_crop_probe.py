"""Offline extension: reuse labelled field crops across historical frame sizes."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import statistics
import subprocess
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from PIL import Image

from .baseline import instrument_reader, load_frozen_ocr, resolve_roots
from .benchmark import set_idle_priority, system_cpu_percent
from .cli import _check_all_inputs, _latest_captures
from .contracts import canonical_bytes, hash_file, write_json
from .engine import FIELD_BOUNDS


VERSION = "backup-field-binary-exact-v1"
MODULE = "local_app.experiments.trade_template_v1.backup_crop_probe"


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def read_jsonl(path):
    return [json.loads(x) for x in Path(path).read_text(encoding="utf-8").splitlines() if x]


def crop_box(image, box):
    x, y, w, h = (int(box.get(k, 0)) for k in ("x", "y", "width", "height"))
    if min(x, y) < 0 or min(w, h) <= 0 or x+w > image.width or y+h > image.height:
        return None
    return image.crop((x, y, x+w, y+h))


def feature_key(mask, scaled=False):
    """Whole foreground, including every component; never match a substring."""
    if mask.size == 0 or not mask.any():
        return None
    ys, xs = np.nonzero(mask)
    tight = mask[ys.min():ys.max()+1, xs.min():xs.max()+1].astype(np.uint8)
    if scaled:
        width = max(1, round(tight.shape[1] * 32 / tight.shape[0]))
        if width > 1600:
            return None
        tight = np.asarray(Image.fromarray(tight).resize((width, 32), Image.Resampling.NEAREST))
    return f"{tight.shape[0]}x{tight.shape[1]}:" + hashlib.sha256(tight.tobytes()).hexdigest()


def text_mask(crop, module):
    mask = module._ink(crop)
    occupied = np.flatnonzero(mask.sum(axis=1) >= 2)
    if not len(occupied):
        return None
    groups = np.split(occupied, np.where(np.diff(occupied) > 2)[0]+1)
    lines = []
    for group in groups:
        if len(group) < 3:
            continue
        band = mask[int(group[0]):int(group[-1])+1]
        ys, xs = np.nonzero(band)
        if not len(xs) or xs.min() == 0 or xs.max() == crop.width-1:
            return None
        lines.append(band[:, xs.min():xs.max()+1])
    if not lines:
        return None
    width = max(x.shape[1] for x in lines)
    result = np.zeros((sum(x.shape[0] for x in lines)+3*(len(lines)-1), width), dtype=bool)
    offset = 0
    for line in lines:
        result[offset:offset+line.shape[0], :line.shape[1]] = line
        offset += line.shape[0]+3
    return result


def quantity_mask(row, field, module):
    """Frozen outline extraction, with a wider guard against omitted digits."""
    import cv2
    bounds = (.287, .55, .340, .93) if field == "reqAmount" else (.663, .50, .724, .95)
    crop = module._crop(row, bounds)
    rgb = np.asarray(crop.convert("RGB"), dtype=np.int16)
    white = (rgb.min(axis=2)>155) & (rgb.max(axis=2)-rgb.min(axis=2)<55)
    dark = (rgb.max(axis=2)<100).astype(np.uint8)
    mask = white & cv2.dilate(dark, np.ones((3, 3), dtype=np.uint8)).astype(bool)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    candidates = [i for i in range(1, count) if stats[i, cv2.CC_STAT_HEIGHT] >= crop.height*.30]
    if not candidates:
        return None
    anchor = stats[max(candidates, key=lambda i: stats[i, cv2.CC_STAT_LEFT]+stats[i, cv2.CC_STAT_WIDTH])]
    top, bottom = anchor[1], anchor[1]+anchor[3]
    candidates = [i for i in candidates if min(bottom, stats[i, 1]+stats[i, 3])-max(top, stats[i, 1]) >= .7*max(anchor[3], stats[i, 3])]
    selected = np.isin(labels, candidates)
    ys, xs = np.nonzero(selected)
    if not len(xs) or xs.min() == 0 or xs.max() == crop.width-1 or ys.min() == 0 or ys.max() == crop.height-1:
        return None
    # Check the wider visible band before discarding whitespace or artwork.
    guard_bounds = (.270, .45, .350, .99) if field == "reqAmount" else (.645, .45, .745, .99)
    guard = module._crop(row, guard_bounds)
    grgb = np.asarray(guard.convert("RGB"), dtype=np.int16)
    gwhite = (grgb.min(axis=2)>155) & (grgb.max(axis=2)-grgb.min(axis=2)<55)
    gcount, _, gstats, _ = cv2.connectedComponentsWithStats(gwhite.astype(np.uint8), 8)
    cx, cy = round(bounds[0]*row.width), round(bounds[1]*row.height)
    gx, gy = round(guard_bounds[0]*row.width), round(guard_bounds[1]*row.height)
    bx0, by0, bx1, by1 = cx+xs.min(), cy+ys.min(), cx+xs.max()+1, cy+ys.max()+1
    for stat in gstats[1:]:
        x, y, w, h = stat[:4]
        x, y = x+gx, y+gy
        overlap = min(by1, y+h)-max(by0, y)
        if h >= (by1-by0)*.6 and overlap >= .7*max(by1-by0, h):
            if x < bx0-1 or x+w > bx1+1:
                return None
    tight = selected[ys.min():ys.max()+1, xs.min():xs.max()+1]
    columns = np.flatnonzero(tight.any(axis=0))
    groups = np.split(columns, np.where(np.diff(columns)>1)[0]+1)
    return tight, len(groups)


def get_features(kind, crop, module, *, row=None, field=None):
    if kind == "quantity":
        found = quantity_mask(row, field, module)
        if found is None:
            return {}, None
        mask, group_count = found
    else:
        mask, group_count = text_mask(crop, module), None
    if mask is None:
        return {}, group_count
    return {mode: feature_key(mask, mode == "scaled") for mode in ("native", "scaled")}, group_count


def lookup(bank, kind, features, group_count, modes=("native", "scaled"), allowed=None):
    matched = []
    ambiguous = False
    for mode in modes:
        key = features.get(mode)
        refs = bank["lookup"].get(f"{kind}|{mode}|{key}", []) if key else []
        labels = {canonical_bytes(r["value"]): r["value"] for r in refs}
        if len(labels)>1:
            ambiguous = True
        if len(labels)==1:
            value = next(iter(labels.values()))
            if kind == "quantity" and len(str(value)) != group_count:
                continue
            if allowed is not None and value not in allowed:
                continue
            matched.append((value, refs, mode))
    labels = {canonical_bytes(x[0]) for x in matched}
    if ambiguous or len(labels) != 1:
        return None
    value = matched[0][0]
    refs = {r["referenceId"]: r for _, items, _ in matched for r in items}
    return {"value": value, "references": list(refs), "modes": sorted({x[2] for x in matched})}


def prepare(spec_dir, previous_run, out_dir):
    spec = Path(spec_dir).resolve()
    manifest_path = spec/"BASELINE-MANIFEST.json"
    manifest = read_json(manifest_path)
    roots = resolve_roots(manifest_path)
    audit = _check_all_inputs(manifest, roots, spec)
    module, _, _ = load_frozen_ocr(roots["preparationRoot"])
    import cv2
    cv2.setNumThreads(1)
    previous = roots["runRoot"]/previous_run
    images = {x["imageSha256"]: x for x in read_jsonl(previous/"data/captures.jsonl")}
    truths = read_jsonl(previous/"data/truth.jsonl")
    split = read_json(previous/"data/split.json")
    roles = {}
    for group in split["groups"]:
        role = group["role"]
        # A separately reported supplemental bank uses a fixed split of the old oracle.
        if role == "LEGACY_EVAL":
            role = "ENROLL" if group["bucket"] < 5 else "CALIBRATION" if group["bucket"] < 7 else "TEST"
        if any(any(m.get('sourceId') == 'latest15-capture-index' for m in images[sha]['memberships']) for sha in group['images']):
            role = 'TEST_LOCKED'
        roles[group["groupId"]] = role
    raw_entries = {}
    for source in manifest["dataSources"]:
        if source["id"] not in {"history-before-cleanup", "recent-before-fixed-roi"}:
            continue
        con = sqlite3.connect((roots["artifactRoot"]/source["path"]).resolve().as_uri()+"?mode=ro", uri=True)
        try:
            for fid, details_text in con.execute("SELECT feedback_id,details_json FROM trade_correction"):
                for index, entry in enumerate(json.loads(details_text).get("corrections", [])):
                    raw_entries[(source["id"], fid, index)] = entry
        finally:
            con.close()
    catalog = read_json(module._experiment_catalog_path)
    items = {x for names in catalog["masterData"].values() for x in names}|set(catalog["specialItems"])
    islands = set(catalog["islands"]+catalog.get("t6Islands", [])+catalog.get("t7Islands", []))
    aliases = {module._normalize(x): x for x in items|islands}
    references, exclusions = [], []
    bank_root = out_dir/"references"
    bank_root.mkdir(parents=True, exist_ok=True)
    for truth in truths:
        role = roles[truth["sourceGroupId"]]
        if role != "ENROLL":
            continue
        field, value = truth["field"], truth["value"]
        kind = "quantity" if field in {"reqAmount", "yield"} else "count" if field == "count" else "island" if field == "island" else "item"
        reason = None
        if kind in {"quantity", "count"}:
            if type(value) is not int or value < (0 if kind == "count" else 1):
                reason = "INVALID_NUMBER"
        else:
            if not isinstance(value, str) or "..." in value or "…" in value:
                reason = "PARTIAL_NAME"
            elif any('...' in str(e.get('rawOCR', '')) or '…' in str(e.get('rawOCR', '')) for e in truth['sourceEvidence']):
                reason = "PARTIAL_NAME"
            elif value not in (islands if kind == "island" else items):
                value = aliases.get(module._normalize(value))
                if value is None:
                    reason = "NAME_OUTSIDE_CATALOG"
        if reason:
            exclusions.append({"truthId": truth["truthId"], "reason": reason})
            continue
        image_path = previous/"data/png"/f"{truth['imageSha256']}.png"
        if hash_file(image_path) != truth['imageSha256']:
            raise ValueError('source PNG hash mismatch')
        image = Image.open(image_path).convert("RGB")
        row = crop_box(image, truth["rowBox"])
        if row is None:
            exclusions.append({"truthId": truth["truthId"], "reason": "ROW_BOX_INVALID"})
            continue
        saved_entry = next((raw_entries.get((e.get("sourceId"), e.get("feedbackId"), e.get("entryIndex"))) for e in truth["sourceEvidence"] if (e.get("sourceId"),e.get("feedbackId"),e.get("entryIndex")) in raw_entries), None)
        saved_box = saved_entry.get("box") if saved_entry else None
        crop = crop_box(image, saved_box) if saved_box else module._crop(row, FIELD_BOUNDS[field])
        if crop is None:
            exclusions.append({"truthId": truth["truthId"], "reason": "FIELD_BOX_INVALID"})
            continue
        features, groups = get_features(kind, crop, module, row=row, field=field)
        if not any(features.values()) or (kind == "quantity" and groups != len(str(value))):
            exclusions.append({"truthId": truth["truthId"], "reason": "INCOMPLETE_FOREGROUND"})
            continue
        ref_id = truth["truthId"]
        crop.save(bank_root/f"{ref_id}.png")
        references.append({"referenceId": ref_id, "truthId": ref_id, "sourceImageSha256": truth["imageSha256"],
                           "sourceGroupId": truth["sourceGroupId"], "sourceClass": truth["truthClass"],
                           "field": field, "kind": kind, "value": value, "features": features,
                           "savedFieldBox": saved_box, "rowBox": truth["rowBox"], "imageSize": list(image.size),
                           "glyphGroups": groups})
    banks = {}
    for bank_name in ("backup", "backup_oracle"):
        selected = [r for r in references if bank_name == "backup_oracle" or r["sourceClass"] != "EXISTING_ORACLE"]
        table = defaultdict(list)
        for ref in selected:
            for mode, feature in ref["features"].items():
                if feature:
                    table[f"{ref['kind']}|{mode}|{feature}"].append(ref)
        banks[bank_name] = {"lookup": dict(table), "references": selected}
        write_json(out_dir/f"bank-{bank_name}.json", banks[bank_name])
    captures = _latest_captures(manifest, roots)
    if [x['imageSha256'] for x in captures] != read_json(previous/'baseline-index.json')['inputImageHashes']:
        raise ValueError('latest captures differ from frozen prior run')
    write_json(out_dir/"captures.json", [{**x, "imagePath": str(x["imagePath"])} for x in captures])
    # Independent labelled captures remain independent; latest 15 are never enrolled.
    eval_truths = [t for t in truths if roles[t["sourceGroupId"]] in {"CALIBRATION", "TEST", "TEST_LOCKED"}]
    quality = {}
    for name, bank in banks.items():
        rows = []
        for truth in eval_truths:
            kind = "quantity" if truth["field"] in {"reqAmount", "yield"} else "count" if truth["field"] == "count" else "island" if truth["field"] == "island" else "item"
            with Image.open(previous/"data/png"/f"{truth['imageSha256']}.png") as opened:
                image = opened.convert("RGB")
            row = crop_box(image, truth["rowBox"])
            if row is None:
                continue
            crop = module._crop(row, FIELD_BOUNDS[truth["field"]])
            features, groups = get_features(kind, crop, module, row=row, field=truth["field"])
            hit = lookup(bank, kind, features, groups)
            if hit:
                rows.append({"truthId": truth["truthId"], "field": truth["field"], "actual": truth["value"],
                             "predicted": hit["value"], "correct": hit["value"] == truth["value"],
                             "role": roles[truth["sourceGroupId"]], "modes": hit["modes"]})
        quality[name] = {"evaluatedTruthFields": len(eval_truths), "hits": len(rows),
                         "wrong": sum(not r["correct"] for r in rows), "details": rows}
    summary = {"version": VERSION, "enrollment": {name: {"references":len(b["references"]),
               "byField":dict(Counter(r["field"] for r in b["references"])),
               "labelsByKind":{kind:sorted({r['value'] for r in b['references'] if r['kind']==kind},key=str) for kind in ('island','item','count','quantity')}} for name,b in banks.items()},
               "excluded":dict(Counter(e["reason"] for e in exclusions)), "quality":quality,
               "legacySplit":dict(Counter(roles[g['groupId']] for g in split['groups'] if g['role']=='LEGACY_EVAL')),
               "protocol":{"wholeFrameGate":False,"glyphDistance":0,"modes":["native","scaled-height32-nearest"],
                           "thresholdTuning":False,"latest15Enrollment":False,"bankIncludesCalibration":False},
               "sourceHashes":audit,"previousRun":str(previous)}
    write_json(out_dir/"preparation.json", summary)
    print(json.dumps({k:v for k,v in summary.items() if k in {"enrollment","excluded","legacySplit"}},ensure_ascii=False))
    print('quality:',{name:{k:v for k,v in value.items() if k!='details'} for name,value in quality.items()},flush=True)


def install_adapter(module, bank, trace):
    catalog = read_json(module._experiment_catalog_path)
    island_names = set(catalog["islands"]+catalog.get("t6Islands", [])+catalog.get("t7Islands", []))
    stats = {"lookupSeconds":0.0,"attempts":0,"hits":0,"byKind":Counter()}
    def find(kind, crop, *, row=None, field=None, allowed=None):
        started = time.perf_counter()
        features, groups = get_features(kind,crop,module,row=row,field=field)
        hit = lookup(bank,kind,features,groups,allowed=allowed)
        stats["lookupSeconds"] += time.perf_counter()-started
        stats["attempts"] += 1
        if hit:
            stats["hits"] += 1
            stats["byKind"][kind] += 1
            trace.append({"kind":kind,**hit})
        return hit
    def result(hit, name=False):
        return {"rawOCR":"", "corrected":hit["value"],"reviewRequired":False,"confidence":None,
                "valueSource":"VERIFIED_TEMPLATE_PROBE","variants":[],
                "templateEvidence":{"references":hit["references"],"modes":hit["modes"]},
                **({"masterMatch":"RESOLVED"} if name else {})}
    original_name, original_count = module.read_catalog_name,module.read_count
    original_req,original_yield = module.read_requirement,module.read_yield
    def names(reader,crop,candidates,literal_candidates=()):
        allowed = set(candidates)|set(literal_candidates)
        kind = "island" if allowed and allowed.issubset(island_names) else "item"
        hit = find(kind,crop,allowed=allowed)
        return result(hit,True) if hit else original_name(reader,crop,candidates,literal_candidates)
    def count(reader,crop):
        hit = find("count",crop)
        return result(hit) if hit else original_count(reader,crop)
    def req(reader,row):
        hit = find("quantity",module._requirement_crop(row),row=row,field="reqAmount")
        return result(hit) if hit else original_req(reader,row)
    def yields(reader,row,allowed_values=None,destination=None):
        hit = find("quantity",module._crop(row,FIELD_BOUNDS['yield']),row=row,field="yield",allowed=set(allowed_values) if allowed_values else None)
        return result(hit) if hit else original_yield(reader,row,allowed_values,destination)
    module.read_catalog_name,module.read_count,module.read_requirement,module.read_yield = names,count,req,yields
    return stats


def arm(payload_path):
    cpu_started = time.process_time()
    payload = read_json(payload_path)
    priority = set_idle_priority()
    import cv2
    cv2.setNumThreads(1)
    module,_,model = load_frozen_ocr(Path(payload["preparationRoot"]))
    for capture in payload['captures']:
        if hash_file(Path(capture['imagePath'])) != capture['imageSha256']:
            raise ValueError('benchmark capture hash changed')
    telemetry = instrument_reader(module)
    trace,stats = [],{}
    bank_started = time.perf_counter()
    if payload["variant"] != "B0":
        bank_path = Path(payload['bank'])
        if hash_file(bank_path) != payload['bankSha256']:
            raise ValueError('bank hash changed')
        stats = install_adapter(module,read_json(bank_path),trace)
    bank_seconds = time.perf_counter()-bank_started
    started = time.perf_counter()
    result = module.recognize_live(payload["captures"],model,"offline-backup-crop-probe")
    write_json(Path(payload["output"]),{"result":result,"trace":trace,"metrics":{**telemetry,
            "recognitionWallSeconds":time.perf_counter()-started,"bankLoadSeconds":bank_seconds,
            "workerCpuSeconds":time.process_time()-cpu_started,
            "priority":priority,"adapterSourceSha256":hash_file(Path(__file__)),
            "templateStats":{**stats,"byKind":dict(stats.get('byKind',{}))}}})


def run_child(out_dir,variant,captures,roots,index):
    folder = out_dir/"arms"/f"{index:02d}-{variant}"
    folder.mkdir(parents=True,exist_ok=False)
    payload = {"variant":variant,"captures":captures,"preparationRoot":str(roots["preparationRoot"]),
               "bank":str(out_dir/f"bank-{variant}.json"),"output":str(folder/"output.json")}
    if variant!='B0':
        payload['bankSha256']=hash_file(Path(payload['bank']))
    write_json(folder/"input.json",payload)
    env = {**os.environ,"PYTHONDONTWRITEBYTECODE":"1","OMP_NUM_THREADS":"1",
           "OPENBLAS_NUM_THREADS":"1","MKL_NUM_THREADS":"1","LOCALAPPDATA":str(folder/"sandbox")}
    (folder/"sandbox").mkdir()
    started = time.perf_counter()
    process = subprocess.Popen([sys.executable,"-B","-m",MODULE,"arm","--input",str(folder/"input.json")],
                               env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    samples=[]
    deadline=time.monotonic()+300
    while process.poll() is None:
        if time.monotonic()>deadline:
            process.kill(); process.communicate()
            raise TimeoutError('only this probe worker was stopped after 300s')
        samples.append(system_cpu_percent(.5))
    stdout,stderr=process.communicate()
    if process.returncode:
        write_json(folder/'error.json',{'stdout':stdout,'stderr':stderr})
        raise RuntimeError(f'worker failed; see {folder}')
    result=read_json(folder/"output.json")
    metrics={**result["metrics"],"processWallSeconds":time.perf_counter()-started,
             "systemCpuMedian":statistics.median(samples) if samples else None,
             "systemCpuSamples":samples,"armPath":str(folder.relative_to(out_dir))}
    write_json(folder/"metrics.json",metrics)
    print(variant,json.dumps({k:metrics[k] for k in ('processWallSeconds','modelCalls','systemCpuMedian','templateStats')},ensure_ascii=False),flush=True)
    return result,metrics


def compare(base,candidate):
    br,cr=base['result']['rows'],candidate['result']['rows']
    hits,changes,nonhit_differences=[],[],[]
    if len(br)!=len(cr):
        return {'rowCountChanged':True}
    for b,c in zip(br,cr):
        for field,bf in b['fields'].items():
            cf=c['fields'][field]
            if cf.get('valueSource')=='VERIFIED_TEMPLATE_PROBE':
                rec={'captureId':c['captureId'],'ordinal':c['ordinal'],'field':field,
                     'baselineValue':bf.get('corrected'),'candidateValue':cf.get('corrected'),
                     'baselineReview':bf.get('reviewRequired'),'candidateReview':cf.get('reviewRequired')}
                hits.append(rec)
                if bf.get('corrected')!=cf.get('corrected') or bf.get('reviewRequired')!=cf.get('reviewRequired'):
                    changes.append(rec)
            elif canonical_bytes(bf)!=canonical_bytes(cf):
                nonhit_differences.append({'captureId':c['captureId'],'ordinal':c['ordinal'],'field':field,
                                          'baseline':bf,'candidate':cf})
    return {'rowCountChanged':False,'templateFields':len(hits),'hitsByField':dict(Counter(x['field'] for x in hits)),
            'changedFields':changes,'fallbackDifferences':nonhit_differences,'hits':hits}


def benchmark(spec_dir,out_dir,phase):
    manifest_path=Path(spec_dir).resolve()/'BASELINE-MANIFEST.json'
    roots=resolve_roots(manifest_path)
    captures=read_json(out_dir/'captures.json')
    preflight=[system_cpu_percent(1) for _ in range(5)]
    write_json(out_dir/f'cpu-{phase}.json',preflight)
    if statistics.median(preflight)>85:
        print('BENCH_CONTENDED: system CPU already >85%; no OCR started',flush=True)
        return
    if phase=='screen':
        captures=[captures[i] for i in (0,3,6,8,11,14)]
        sequence=['B0','backup','backup_oracle']
    else:
        screen=read_json(out_dir/'screen.json')
        viable=[(name,rec) for name,rec in screen['variants'].items() if rec['metrics']['modelCalls']<screen['baseline']['modelCalls'] and not rec['comparison']['changedFields'] and not rec['comparison']['fallbackDifferences']]
        if not viable:
            print('No unchanged-output speed candidate; full comparison not run',flush=True)
            return
        candidate=min(viable,key=lambda x:x[1]['metrics']['modelCalls'])[0]
        sequence=['B0',candidate] if phase == 'cpu' else ['B0',candidate,candidate,'B0','B0',candidate]
    arm_index=len(list((out_dir/'arms').glob('*'))) if (out_dir/'arms').exists() else 0
    baseline=None
    records=[]
    variants={}
    for index,variant in enumerate(sequence,arm_index):
        result,metrics=run_child(out_dir,variant,captures,roots,index)
        comparison=None
        if variant=='B0':
            baseline=result
        elif baseline:
            comparison=compare(baseline,result)
            variants[variant]={'metrics':metrics,'comparison':comparison}
        records.append({'variant':variant,'metrics':metrics,'comparison':comparison})
    summary={'phase':phase,'captureCount':len(captures),'baseline':next(r['metrics'] for r in records if r['variant']=='B0'),
             'variants':variants,'arms':records}
    if phase=='full':
        bv=[r['metrics']['processWallSeconds'] for r in records if r['variant']=='B0']
        cv=[r['metrics']['processWallSeconds'] for r in records if r['variant']!='B0']
        bc=[r['metrics']['modelCalls'] for r in records if r['variant']=='B0']
        cc=[r['metrics']['modelCalls'] for r in records if r['variant']!='B0']
        load={name:[r['metrics']['systemCpuMedian'] for r in records if (r['variant']=='B0')==(name=='B0')] for name in ('B0','candidate')}
        variation=max(statistics.stdev(v)/statistics.mean(v) for v in (bv,cv))
        summary.update({'baselineWallMedian':statistics.median(bv),'candidateWallMedian':statistics.median(cv),
                        'observedGain':1-statistics.median(cv)/statistics.median(bv),'modelCallReduction':1-statistics.median(cc)/statistics.median(bc),
                        'timeCVMax':variation,'cpuLoadMedians':{k:statistics.median(v) for k,v in load.items()},
                        'contended':variation>.15 or any(statistics.median(v)>85 for v in load.values()) or abs(statistics.median(load['B0'])-statistics.median(load['candidate']))>15})
    write_json(out_dir/f'{phase}.json',summary)
    print(json.dumps({k:v for k,v in summary.items() if k not in {'arms','variants','baseline'}},ensure_ascii=False),flush=True)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('command',choices=['prepare','screen','full','cpu','arm'])
    parser.add_argument('--spec-dir',default='specs/trade-template-v1')
    parser.add_argument('--previous-run',default='template-v1-20261016-a')
    parser.add_argument('--out')
    parser.add_argument('--input')
    args=parser.parse_args()
    if args.command=='arm':
        return arm(args.input)
    out_dir=Path(args.out).resolve()
    out_dir.mkdir(parents=True,exist_ok=True)
    if args.command=='prepare':
        return prepare(args.spec_dir,args.previous_run,out_dir)
    return benchmark(args.spec_dir,out_dir,args.command)


if __name__=='__main__':
    main()
