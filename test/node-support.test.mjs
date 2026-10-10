import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_NODE_VERSION, supportsNode, assertSupportedNode } from '../src/node-support.mjs';

test('supported Node versions include Node 20.18 and the requested 20.20.2', () => {
  assert.equal(MIN_NODE_VERSION, '20.18.0');
  for (const version of ['20.18.0', '20.18.1', '20.20.2', 'v20.20.2', '22.13.0', '22.18.0', '24.0.0']) {
    assert.equal(supportsNode(version), true, version);
    assert.doesNotThrow(() => assertSupportedNode(version));
  }
});

test('unsupported and malformed Node versions produce an actionable error', () => {
  for (const version of ['18.20.8', '20.0.0', '20.17.0', '22', 'unknown']) {
    assert.equal(supportsNode(version), false, version);
    assert.throws(() => assertSupportedNode(version), /Node.js >= 20.18.0 is required/);
  }
});
