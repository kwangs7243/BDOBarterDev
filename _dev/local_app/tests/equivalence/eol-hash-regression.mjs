import { strict as assert } from 'node:assert';
import { normalizeTextEol, sha256Bytes, sha256TextEol } from './source-tools.mjs';

const baselineCode = 'const status = "ready";\nfunction route() {\n  return 1;\n}\n';
const expectedCodeHash = sha256TextEol(baselineCode);
const crlfCode = baselineCode.replace(/\n/g, '\r\n');
assert.equal(sha256TextEol(crlfCode), expectedCodeHash, 'CRLF/LF-only changes must pass');
assert.equal(normalizeTextEol(crlfCode), baselineCode);
assert.notEqual(sha256TextEol(baselineCode.replace('status = "ready"', 'status = "other"')), expectedCodeHash,
  'a real code character change must fail');

const protectedFunction = 'function protectedRoute() {\n  return "safe";\n}\n';
const protectedFunctionHash = sha256TextEol(protectedFunction);
assert.notEqual(sha256TextEol(protectedFunction.replace('safe', 'changed')), protectedFunctionHash,
  'a protected function body change must fail');

const protectedConstant = 'const MAX_SLOTS = 105;\n';
const protectedConstantHash = sha256TextEol(protectedConstant);
assert.notEqual(sha256TextEol(protectedConstant.replace('105', '106')), protectedConstantHash,
  'a protected constant change must fail');
assert.notEqual(sha256TextEol(protectedConstant.replace('105;\n', '105; \n')), protectedConstantHash,
  'trailing or other whitespace changes must fail');

const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
const changedBinary = Buffer.from(binary);
changedBinary[5] ^= 0x01;
assert.notEqual(sha256Bytes(changedBinary), sha256Bytes(binary), 'a one-byte binary change must fail raw-byte hashing');

console.log(JSON.stringify({
  eolOnlyChange: 'PASS',
  realCodeCharacterChange: 'FAIL_DETECTED',
  protectedFunctionChange: 'FAIL_DETECTED',
  protectedConstantChange: 'FAIL_DETECTED',
  whitespaceChange: 'FAIL_DETECTED',
  binaryOneByteChange: 'FAIL_DETECTED',
}, null, 2));