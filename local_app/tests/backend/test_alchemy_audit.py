from collections import Counter
from contextlib import closing
from copy import deepcopy
import json
from pathlib import Path
import random
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from alchemy.batches import choose_batches
from alchemy.catalog import AlchemyError, graph, ingredients, load_catalog, validate_catalog
from alchemy.catalog_updates import merge_catalog
from alchemy.engine import plan_goals
from alchemy.storage import AlchemyStorage, encode
from local_app.backend.app import create_app
from local_app.tests.backend.test_alchemy_engine import sample, goal

ROOT = Path(__file__).resolve().parents[3]


class AlchemyAuditTests(unittest.TestCase):
    def test_all_recipes_sources_graphs_and_audit_coverage(self):
        catalog = load_catalog()
        items, recipes = validate_catalog(catalog)
        audit = json.loads((ROOT / 'alchemy/data/recipe-audit.json').read_text(encoding='utf-8'))
        self.assertEqual((len(items), len(recipes)), (170, 87))
        self.assertEqual({r['recipe_id'] for r in audit['recipes']}, set(recipes))
        self.assertEqual(len({r['game_item_id'] for r in items.values()}), 170)
        reachable = set()
        for recipe in recipes.values():
            with self.subTest(recipe=recipe['recipe_id']):
                self.assertTrue(recipe['source_evidence'])
                self.assertFalse(any('card/?class1=' in url for url in recipe['source_urls']))
                graph(catalog, recipe['output_item_id'], {recipe['output_item_id']: recipe['recipe_id']})
                for row in recipe['inputs']:
                    for alternate in row.get('alternatives', []):
                        self.assertIn((row['quantity'], alternate['quantity']), ((1, 1), (3, 1), (30, 10), (300, 100)))
                        self.assertFalse(alternate['mixing_allowed'])
        for product in catalog['products']:
            _, selected, _ = graph(catalog, product)
            reachable.update(r['recipe_id'] for r in selected.values())
        self.assertGreater(len(reachable), 50)

    def test_all_nine_families_mix_110_and_sum_exact_inputs(self):
        catalog = load_catalog()
        groups = {r['batch_group'] for r in catalog['recipes'] if r.get('batch_group')}
        self.assertEqual(len(groups), 9)
        stock = {i['item_id']: 100000 for i in catalog['items']}
        for product in groups:
            with self.subTest(product=product):
                options = [r for r in catalog['recipes'] if r.get('batch_group') == product]
                plan = plan_goals(catalog, {**stock, product: 0}, [goal(item_id=product, quantity=110, batch_policies={product: 'surplus'})])[0]
                self.assertFalse(plan['errors'])
                row = plan['rows'][0]
                self.assertEqual((row['calls'], row['planned_output'], row['surplus']), (2, 110, 0))
                self.assertEqual({b['recipe_id']: b['calls'] for b in row['batches']}, {r['recipe_id']: 1 for r in options})
                expected = Counter()
                for recipe in options:
                    expected.update({v['item_id']: v['quantity'] for v in ingredients(recipe)})
                self.assertEqual({v['item_id']: v['quantity'] for v in row['inputs']}, dict(expected))

    def test_batch_optimizer_matches_exhaustive_oracle_and_handles_unknown(self):
        rng = random.Random(867)
        options = [{**sample()['recipes'][0], 'recipe_id': str(n), 'output_quantity': n,
                    'inputs': [{'item_id': 'A', 'quantity': 30 if n == 10 else 300},
                               {'item_id': 'B' if n == 10 else 'X', 'quantity': 10}]} for n in (10, 100)]
        for _ in range(60):
            missing = rng.randint(1, 1500)
            stock = {i: rng.choice([None, rng.randint(0, 5000)]) for i in 'ABX'}
            for policy in ('surplus', 'shortage', 'calls'):
                def score(x, y):
                    needed = {'A': x * 30 + y * 300, 'B': x * 10, 'X': y * 10}
                    unknown = sum(q for i, q in needed.items() if stock[i] is None)
                    short = sum(max(0, q-stock[i]) for i, q in needed.items() if stock[i] is not None)
                    excess, calls = 10*x + 100*y-missing, x+y
                    return {'surplus': (excess, unknown, short, calls), 'shortage': (unknown, short, excess, calls),
                            'calls': (calls, excess, unknown, short)}[policy]
                expected = min(score(max(0, (missing+9)//10-10*y), y) for y in range((missing+99)//100+1))
                batches = choose_batches(options, missing, policy, stock)
                counts = {r['recipe_id']: r['calls'] for r in batches}
                self.assertEqual(score(counts.get('10', 0), counts.get('100', 0)), expected)
        self.assertLessEqual(len(choose_batches(options, 10000000, 'shortage', {'A': 0, 'B': 0, 'X': 0})), 2)

    def test_single_large_batch_displays_its_actual_recipe_and_fixed_yield(self):
        data=load_catalog()
        product=next(r['output_item_id'] for r in data['recipes'] if r.get('batch_group'))
        stock={i['item_id']:100000 for i in data['items']}
        result=plan_goals(data,{**stock,product:0},[goal(item_id=product,quantity=151,batch_policies={product:'calls'})])[0]
        row=result['rows'][0]
        self.assertEqual((row['calls'],row['planned_output'],row['expected_yield']),(2,200,100))
        large=next(r for r in data['recipes'] if r['output_item_id']==product and r['output_quantity']==100)
        self.assertEqual(row['recipe_id'],large['recipe_id'])

    def test_zero_observed_yield_is_not_reported_as_materials_satisfied(self):
        from alchemy.yields import recipe_key
        data=sample()
        statistics={recipe_key(data['recipes'][1]):{'average':0,'total_calls':2,'total_output':0,'jobs':1}}
        result=plan_goals(data,{'F':0,'A':0,'B':100},[goal()],statistics)[0]
        self.assertFalse(result['materials_satisfied'])
        self.assertTrue(any(r['status']=='yield_unknown' for r in result['rows']))

    def test_independent_ready_is_distinct_from_shared_plan_feasibility(self):
        data = sample()
        data['recipes'][0]['inputs'] = [{'item_id': 'A', 'quantity': 1}, {'item_id': 'X', 'quantity': 1}]
        data['recipes'][1].update(yield_type='fixed', inputs=[{'item_id': 'B', 'quantity': 3}])
        data['recipes'].append({**deepcopy(data['recipes'][1]), 'recipe_id': 'x', 'output_item_id': 'X'})
        result = plan_goals(data, {'F': 0, 'A': 0, 'X': 0, 'B': 4}, [goal(quantity=1)])[0]
        rows = {r['item_id']: r for r in result['rows']}
        self.assertTrue(rows['A']['ready'] and rows['X']['ready'])
        self.assertEqual(sum(rows[i]['plan_ready'] for i in 'AX'), 1)
        self.assertEqual(rows['B']['missing'], 2)
        self.assertFalse(result['materials_satisfied'])
        unknown = plan_goals(data, {'F': 0, 'A': 0, 'X': 0}, [goal(quantity=1)])[0]
        self.assertTrue(unknown['has_unknown'])
        self.assertIsNone(unknown['base_materials'][0]['missing'])

    def test_partial_mixing_is_blocked_until_game_verification(self):
        data = load_catalog()
        recipe = next(r for r in data['recipes'] if any(i.get('alternatives') for i in r['inputs']))
        row = next(i for i in recipe['inputs'] if i.get('alternatives'))
        with self.assertRaises(AlchemyError):
            ingredients(recipe, {recipe['recipe_id']+':'+row['item_id']: {row['item_id']: 3}})
        row['alternatives'][0]['mixing_allowed'] = True
        with self.assertRaises(AlchemyError):
            validate_catalog(data)

    def test_common_category_is_not_direct_evidence(self):
        data = load_catalog()
        data['recipes'][0]['source_urls'] = ['https://black.inven.co.kr/dataninfo/card/?class1=30001']
        with self.assertRaises(AlchemyError):
            validate_catalog(data)

    def test_icon_duplicates_game_ids_mime_and_placeholder(self):
        catalog = load_catalog()
        audit = json.loads((ROOT / 'alchemy/data/icon-audit.json').read_text(encoding='utf-8'))
        self.assertEqual(len(audit['items']), 170)
        self.assertTrue(all(r['status'] == 'CONFIRMED' for r in audit['items']))
        source = json.loads((ROOT / 'alchemy/data/icon-sources.json').read_text(encoding='utf-8'))
        groups = {}
        for row in source['items']:
            groups.setdefault(row['sha256'], []).append(row['source_id'])
        self.assertEqual([sorted(ids) for ids in groups.values() if len(ids)>1], [[782, 783]])
        with tempfile.TemporaryDirectory() as temp:
            client = create_app(Path(temp)/'barter.sqlite3', testing=True).test_client()
            for item in catalog['items']:
                for suffix in ('.png', '.webp'):
                    response = client.get('/alchemy/assets/icons/'+item['item_id']+suffix)
                    self.assertEqual((response.status_code, response.mimetype), (200, 'image/webp'))
            response = client.get('/alchemy/assets/item-unavailable.svg')
            self.assertEqual((response.status_code, response.mimetype), (200, 'image/svg+xml'))


class CatalogUpdateTests(unittest.TestCase):
    def test_old_job_snapshot_survives_catalog_upgrade_finish_and_restore(self):
        base, upstream = sample(), sample()
        upstream['version'] = 'next'
        upstream['recipes'][1]['inputs'][0]['quantity'] = 3
        with tempfile.TemporaryDirectory() as temp, patch('alchemy.storage.load_catalog', return_value=base) as shipped:
            store = AlchemyStorage(Path(temp)/'test.sqlite3')
            def change(action, **fields):
                return store.mutate(action, {'mutationId':str(uuid4()), 'baseRevision':store.snapshot()['revision'], **fields})
            with closing(store.connect()) as db:
                db.executemany('INSERT INTO settings VALUES (?,?)', [('catalog',encode(base)),('catalog_base',encode(base))])
                db.commit()
            change('inventory', changes=[{'item_id':i,'quantity':q} for i,q in {'F':0,'A':0,'X':0,'B':20}.items()])
            job = change('start', recipe_id='a', calls=2)['job']
            shipped.return_value = upstream
            before = store.snapshot()
            self.assertTrue(before['catalog_update']['available'])
            self.assertEqual(store.snapshot(), before, 'read-only update preview must not mutate the DB')
            result = change('catalog_update', token=before['catalog_update']['token'], resolutions={})
            self.assertEqual(store.snapshot()['jobs'][0]['recipe'], job['recipe'])
            change('finish', job_id=job['job_id'], executed_calls=1, outputs={'A':2})
            self.assertEqual(store.snapshot()['inventory']['B'],18)
            self.assertEqual(store.snapshot()['inventory']['A'],2)
            backup = store.export()
            self.assertTrue(store.validate_backup(backup)['valid'])
            change('restore', backup=backup)
            self.assertEqual(store.snapshot()['inventory']['B'],18)
            original = store.export(result['previous_backup_id'])
            change('restore', backup=original)
            self.assertEqual(store.snapshot()['jobs'][0]['recipe'],job['recipe'])
            self.assertTrue(store.snapshot()['catalog_update']['available'])
            change('cancel', job_id=job['job_id'])
            self.assertEqual(store.snapshot()['inventory']['B'],20)

    def test_merge_preserves_user_changes_and_requires_conflict_resolution(self):
        base, saved, upstream = sample(), sample(), sample()
        saved['recipes'][0]['output_quantity'] = 2
        upstream['version'] = 'next'
        upstream['recipes'][1]['output_quantity'] = 3
        merged, info = merge_catalog(saved, upstream, base)
        self.assertFalse(info['conflicts'])
        self.assertEqual([r['output_quantity'] for r in merged['recipes']], [2, 3])
        upstream['recipes'][0]['output_quantity'] = 4
        merged, info = merge_catalog(saved, upstream, base)
        self.assertEqual(len(info['conflicts']), 1)
        self.assertTrue(merged['recipes'][0]['update_conflict'])
        resolved, info = merge_catalog(saved, upstream, base, {'recipes:f': 'user'})
        self.assertFalse(info['conflicts'])
        self.assertEqual(resolved['recipes'][0]['output_quantity'], 2)
        self.assertNotIn('update_conflict', resolved['recipes'][0])
        unknown, info = merge_catalog(saved, upstream)
        self.assertEqual(unknown, saved)
        self.assertTrue(info['base_unknown'])

    def test_transaction_backup_jobs_revision_idempotency_and_restart(self):
        base, saved, upstream = sample(), sample(), sample()
        saved['recipes'][0]['output_quantity'] = 2
        upstream['version'] = 'next'
        upstream['recipes'][0]['output_quantity'] = 3
        with tempfile.TemporaryDirectory() as temp, patch('alchemy.storage.load_catalog', return_value=upstream):
            store = AlchemyStorage(Path(temp)/'test.sqlite3')
            with closing(store.connect()) as db:
                db.executemany('INSERT INTO settings VALUES (?,?)', [('catalog', encode(saved)), ('catalog_base', encode(base))])
                db.commit()
            before = store.snapshot()
            with self.assertRaises(AlchemyError):
                store.mutate('start', {'mutationId':'blocked','baseRevision':0,'recipe_id':'f','calls':1})
            self.assertEqual(store.snapshot()['revision'], 0)
            payload = {'mutationId': 'upgrade', 'baseRevision': 0, 'token': before['catalog_update']['token'], 'resolutions': {'recipes:f':'user'}}
            result = store.mutate('catalog_update', payload)
            self.assertEqual(store.mutate('catalog_update', payload), result)
            backup = store.export(result['previous_backup_id'])
            self.assertEqual(json.loads(next(r['value'] for r in backup['tables']['settings'] if r['key']=='catalog')), saved)
            self.assertTrue(store.validate_backup(store.export())['valid'])
            store = AlchemyStorage(store.path)
            self.assertFalse(store.snapshot()['catalog_update']['available'])
            with closing(store.connect()) as db:
                self.assertEqual(store.catalog(db)['recipes'][0]['output_quantity'], 2)
            with self.assertRaises(AlchemyError):
                store.mutate('catalog_update', {**payload, 'mutationId':'stale'})
