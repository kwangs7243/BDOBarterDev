import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image

from barter.tools import trade_template_reader as templates
from barter.tools.trade_live_ocr import _crop, _ink


class TradeTemplateReaderTests(unittest.TestCase):
    def test_repository_bank_matches_pinned_runtime_integrity(self):
        path = Path(__file__).resolve().parents[3] / 'barter/recognition_data/trade-templates.json'
        reader = templates.TemplateReader(path, ink=_ink, crop=_crop)
        self.assertTrue(reader.stats['available'], 'fresh source checkout must include its verified bank')
        self.assertGreater(reader.stats['referenceCount'], 0)

    def test_whole_field_does_not_match_substring_or_clipped_edge(self):
        glyph = np.zeros((20, 40, 3), dtype=np.uint8)
        glyph[4:15, 5:9] = 255
        glyph[4:15, 14:18] = 255
        image = Image.fromarray(glyph)
        extractor = type('Extractor', (), {'_ink': staticmethod(_ink)})
        features, groups = templates.get_features('item', image, extractor)
        bank = {'lookup': {f'item|{mode}|{key}': [{'value': 'complete', 'referenceId': 'a'}]
                           for mode, key in features.items()}}
        self.assertEqual(templates.lookup(bank, 'item', features, groups)['value'], 'complete')
        glyph[4:15, 26:30] = 255
        other, groups = templates.get_features('item', Image.fromarray(glyph), extractor)
        self.assertIsNone(templates.lookup(bank, 'item', other, groups))
        self.assertIsNone(templates.text_mask(image.crop((5, 0, 40, 20)), extractor))

    def test_ambiguous_or_disallowed_labels_and_partial_number_abstain(self):
        refs = [{'value': 12, 'referenceId': 'a'}]
        bank = {'lookup': {'quantity|native|key': refs}}
        self.assertIsNone(templates.lookup(bank, 'quantity', {'native': 'key'}, 1))
        self.assertIsNone(templates.lookup(bank, 'quantity', {'native': 'key'}, 2, allowed={2, 3}))
        self.assertEqual(templates.lookup(bank, 'quantity', {'native': 'key'}, 2)['value'], 12)
        refs.append({'value': 2, 'referenceId': 'b'})
        self.assertIsNone(templates.lookup(bank, 'quantity', {'native': 'key'}, 2))
        bank = {'lookup': {'item|native|a': [{'value': 'one', 'referenceId': 'a'}],
                           'item|scaled|b': [{'value': 'two', 'referenceId': 'b'}]}}
        self.assertIsNone(templates.lookup(bank, 'item', {'native': 'a', 'scaled': 'b'}, None))

    def test_quantity_context_keeps_leading_digits_outside_the_compact_crop(self):
        row = np.zeros((70, 987, 3), dtype=np.uint8)
        row[42:53, 320:325] = 255
        extractor = type('Extractor', (), {'_ink': staticmethod(_ink), '_crop': staticmethod(_crop)})
        single = templates.quantity_context_key(Image.fromarray(row), 'reqAmount', extractor)
        row[42:53, 272:277] = 255
        complete = templates.quantity_context_key(Image.fromarray(row), 'reqAmount', extractor)
        self.assertNotEqual(single, complete)
        bank = {'lookup': {f'quantity|context|{single}': [{'value': 5, 'referenceId': 'five'}]}}
        self.assertIsNone(templates.lookup(bank, 'quantity', {'context': complete}, None))
        bank['lookup'][f'quantity|context|{complete}'] = [{'value': 105, 'referenceId': 'complete'}]
        hit = templates.lookup(bank, 'quantity', {'context': complete}, None)
        self.assertEqual(hit['value'], 105)
        self.assertEqual(hit['modes'], ['context'])
        self.assertIsNone(templates.lookup(bank, 'quantity', {'context': complete}, None, allowed={2, 3}))

    def test_quantity_context_conflicts_and_ambiguous_foreground_still_abstain(self):
        bank = {'lookup': {'quantity|native|a': [{'value': 5, 'referenceId': 'a'}],
                           'quantity|context|b': [{'value': 500, 'referenceId': 'b'}]}}
        self.assertIsNone(templates.lookup(bank, 'quantity', {'native': 'a', 'context': 'b'}, 1))
        bank['lookup']['quantity|native|a'].append({'value': 3, 'referenceId': 'c'})
        self.assertIsNone(templates.lookup(bank, 'quantity', {'native': 'a', 'context': 'b'}, 1))
        bank['lookup'] = {'quantity|context|b': [{'value': 5, 'referenceId': 'a'}, {'value': 500, 'referenceId': 'b'}]}
        self.assertIsNone(templates.lookup(bank, 'quantity', {'context': 'b'}, None))

    def test_quantity_context_survives_foreground_segmentation_failure_without_guessing(self):
        row = Image.new('RGB', (987, 70))
        row.paste('white', (680, 42, 688, 54))
        extractor = type('Extractor', (), {'_ink': staticmethod(_ink), '_crop': staticmethod(_crop)})
        with patch.object(templates, 'quantity_mask', return_value=None):
            features, groups = templates.get_features('quantity', row, extractor, row=row, field='yield')
        self.assertIsNone(groups)
        self.assertEqual(set(features), {'context'})
        self.assertIsNotNone(features['context'])
        self.assertIsNone(templates.lookup({'lookup': {}}, 'quantity', features, groups))
        self.assertIsNone(templates.quantity_context_key(Image.new('RGB', (987, 70)), 'yield', extractor))

    def test_integrity_capture_fidelity_and_optional_failure_preserve_fallback(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)/'bank.json'
            path.write_text(json.dumps({'version': templates.VERSION, 'referenceCount': 1, 'lookup': {}}))
            reader = templates.TemplateReader(path, ink=_ink, crop=_crop)
            self.assertFalse(reader.stats['available'])
            with patch.object(templates, 'BANK_SHA256', hashlib.sha256(path.read_bytes()).hexdigest()):
                reader = templates.TemplateReader(path, ink=_ink, crop=_crop)
            image = Image.new('RGB', (987, 456))
            metadata = {'sourceType': 'native-screen', 'fidelity': {'rescaled': False, 'evidence': 'native-pixels'}}
            reader.configure(image, metadata)
            self.assertTrue(reader.enabled)
            with patch.object(templates, 'get_features', side_effect=ValueError('optional lookup failure')):
                self.assertIsNone(reader.match('item', image))
            self.assertEqual(reader.stats['lookupErrors'], 1)
            for other in ({'sourceType': 'file', 'fidelity': metadata['fidelity']},
                          {**metadata, 'fidelity': {**metadata['fidelity'], 'rescaled': True}}):
                reader.configure(image, other)
                self.assertFalse(reader.enabled)
            reader.configure(Image.new('RGB', (988, 456)), metadata)
            self.assertFalse(reader.enabled)
