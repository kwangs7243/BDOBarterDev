"""Export candidate crops for explicit offline visual audit; no automatic labelling."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from .baseline import load_frozen_ocr
from .backup_crop_probe import crop_box, get_features, lookup, read_json
from .contracts import write_json


def prepare(snapshot: Path, root: Path, preparation: Path, bank_path: Path):
    root.mkdir(parents=True, exist_ok=True)
    (root/'png').mkdir(exist_ok=True)
    (root/'crops').mkdir(exist_ok=True)
    con=sqlite3.connect(snapshot.resolve().as_uri()+'?mode=ro',uri=True)
    records={}
    first={}
    for cid,created,blob,text in con.execute('SELECT capture_id,created_at,image_png,details_json FROM trade_correction ORDER BY created_at'):
        if created<='2026-10-15T14:45:59.197Z':continue
        details=json.loads(text);snap=details.get('snapshot',{})
        if not snap.get('rows'):continue
        records[cid]={'details':details,'createdAt':created,'blob':blob}
        bid=snap['batchId'];first.setdefault(bid,created)
    con.close()
    batches=sorted(first,key=first.get)
    if len(batches)<2:raise ValueError('need separate enrollment and test batches')
    test_batch=batches[-1]
    module,_,_=load_frozen_ocr(preparation)
    catalog=read_json(module._experiment_catalog_path)
    items={x for names in catalog['masterData'].values() for x in names}|set(catalog['specialItems'])
    islands=set(catalog['islands']+catalog.get('t6Islands',[])+catalog.get('t7Islands',[]))
    bank=read_json(bank_path)
    candidates=[];captures=[];excluded=Counter();seen=set()
    for cid,record in records.items():
        details=record['details'];snap=details['snapshot'];bid=snap['batchId']
        sha=hashlib.sha256(record['blob']).hexdigest()
        path=root/'png'/f'{sha}.png'
        if not path.exists():path.write_bytes(record['blob'])
        image=Image.open(io.BytesIO(record['blob'])).convert('RGB')
        role='TEST' if bid==test_batch else 'ENROLL'
        captures.append({'captureId':cid,'metadata':details['metadata'],'imagePath':str(path),
                         'imageSha256':sha,'batchId':bid,'role':role,'createdAt':record['createdAt'],
                         'storedRows':snap['rows']})
        for row in snap['rows']:
            if row.get('excluded'):continue
            row_image=crop_box(image,row['rowBox'])
            if row_image is None:continue
            for field,value in row['fields'].items():
                label=value.get('corrected')
                if value.get('reviewRequired') or value.get('valueSource')=='TRADE_RULE' or label is None:
                    excluded['UNRESOLVED_OR_RULE']+=1;continue
                kind='quantity' if field in {'reqAmount','yield'} else 'count' if field=='count' else 'island' if field=='island' else 'item'
                if kind in {'island','item'}:
                    if label not in (islands if kind=='island' else items) or '...' in str(value.get('rawOCR','')) or '…' in str(value.get('rawOCR','')):
                        excluded['NAME_INCOMPLETE_OR_UNKNOWN']+=1;continue
                box=value.get('box');crop=crop_box(image,box or {})
                if crop is None:
                    excluded['BAD_BOX']+=1;continue
                features,groups=get_features(kind,crop,module,row=row_image,field=field)
                if not any(features.values()) or kind=='quantity' and groups!=len(str(label)):
                    excluded['INCOMPLETE_FOREGROUND']+=1;continue
                identity=f'{sha}:{row["ordinal"]}:{field}'
                sid=hashlib.sha256(identity.encode()).hexdigest()
                if sid in seen:continue
                seen.add(sid)
                reference=lookup(bank,kind,features,groups)
                source='HUMAN_CONFIRMED_FIELD' if value.get('valueSource')=='USER_REVIEW' else 'AUTOMATIC_CANDIDATE'
                crop.save(root/'crops'/f'{sid}.png')
                candidates.append({'sampleId':sid,'captureId':cid,'imageSha256':sha,'batchId':bid,'role':role,
                    'ordinal':row['ordinal'],'field':field,'kind':kind,'candidate':label,'source':source,
                    'rawOCR':value.get('rawOCR'),'features':features,'glyphGroups':groups,'fieldBox':box,
                    'rowBox':row['rowBox'],'oldBankHit':reference})
    write_json(root/'captures.json',captures)
    write_json(root/'candidates.json',candidates)
    # One actual crop per label/role is visually inspected. Other instances are not silently relabelled.
    representatives={}
    for sample in candidates:
        if sample['source']=='HUMAN_CONFIRMED_FIELD':continue
        key=(sample['role'],sample['kind'],str(sample['candidate']))
        representatives.setdefault(key,sample)
    groups=defaultdict(list)
    for sample in representatives.values():groups[sample['role']].append(sample)
    pages=[];font=ImageFont.truetype(r'C:\Windows\Fonts\malgun.ttf',14)
    for role,samples in groups.items():
        samples.sort(key=lambda s:(s['kind'],str(s['candidate'])))
        for start in range(0,len(samples),24):
            chunk=samples[start:start+24]
            canvas=Image.new('RGB',(1440,140*6),'#1b2028');draw=ImageDraw.Draw(canvas)
            entries=[]
            for i,sample in enumerate(chunk):
                x=(i%4)*360;y=(i//4)*140
                crop=Image.open(root/'crops'/f'{sample["sampleId"]}.png').convert('RGB')
                scale=min(2.0,346/crop.width,90/crop.height)
                crop=crop.resize((max(1,round(crop.width*scale)),max(1,round(crop.height*scale))),Image.Resampling.NEAREST)
                draw.text((x+5,y+3),f'{start+i+1:03d} {sample["kind"]} {sample["candidate"]}',font=font,fill='white')
                canvas.paste(crop,(x+5,y+32))
                draw.text((x+5,y+119),sample['sampleId'][:12],font=font,fill='#9ba7b8')
                entries.append({'number':start+i+1,'sampleId':sample['sampleId'],'kind':sample['kind'],'candidate':sample['candidate']})
            name=f'visual-{role.lower()}-{start//24+1:02d}.png';canvas.save(root/name)
            pages.append({'page':name,'role':role,'samples':entries})
    write_json(root/'visual-pages.json',pages)
    summary={'captureCount':len(captures),'rows':sum(len(c['storedRows']) for c in captures),
             'batches':[{'batchId':b,'first':first[b],'role':'TEST' if b==test_batch else 'ENROLL'} for b in batches],
             'candidateFields':len(candidates),'bySource':dict(Counter(s['source'] for s in candidates)),
             'byKind':dict(Counter(s['kind'] for s in candidates)),'oldBankHits':sum(s['oldBankHit'] is not None for s in candidates),
             'visualRepresentatives':len(representatives),'pages':len(pages),'excluded':dict(excluded),
             'labelsAreCandidatesUntilAudited':True}
    write_json(root/'summary.json',summary)
    print(json.dumps(summary,ensure_ascii=False),flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--snapshot',type=Path,required=True)
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--preparation',type=Path,required=True)
    parser.add_argument('--bank',type=Path,required=True)
    args=parser.parse_args()
    prepare(args.snapshot,args.out,args.preparation,args.bank)
