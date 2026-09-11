const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDuplicateStore, hammingDistance } = require('../../../src/whatsapp/duplicate-store');

function temporaryPath() {
  return path.join(os.tmpdir(), `wa-duplicate-store-${process.pid}-${Math.random()}.json`);
}

test('claims exact image hashes and persists records across store instances', () => {
  const filePath = temporaryPath();
  const sha256 = 'a'.repeat(64);
  const first = createDuplicateStore({ filePath });
  const claim = first.claimImage({ sha256, processingId: 'wa-first', groupIdHash: 'group-a' });
  assert.equal(claim.duplicate, false);
  first.registerImageEvidence({ sha256, phash: '0123456789abcdef', processingId: 'wa-first' });

  const second = createDuplicateStore({ filePath });
  const duplicate = second.claimImage({ sha256, processingId: 'wa-second', groupIdHash: 'group-b' });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.matchType, 'SHA256');
  assert.equal(duplicate.record.processing_id, 'wa-first');
  fs.unlinkSync(filePath);
});

test('recognizes a recompressed image by pHash only with matching identity and amount', () => {
  const store = createDuplicateStore({ filePath: temporaryPath(), phashMaxDistance: 6 });
  const firstSha = 'b'.repeat(64);
  const secondSha = 'c'.repeat(64);
  store.claimImage({ sha256: firstSha, processingId: 'wa-first', groupIdHash: 'group-a' });
  store.registerImageEvidence({
    sha256: firstSha,
    phash: '0000000000000000',
    captionEmail: 'customer@example.com',
    amountCents: 2000,
    processingId: 'wa-first',
  });
  store.claimImage({ sha256: secondSha, processingId: 'wa-second', groupIdHash: 'group-b' });
  const duplicate = store.registerImageEvidence({
    sha256: secondSha,
    phash: '0000000000000001',
    captionEmail: 'customer@example.com',
    amountCents: 2000,
    processingId: 'wa-second',
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.matchType, 'PHASH');
  assert.equal(duplicate.distance, 1);
  assert.equal(hammingDistance('0000000000000000', '0000000000000001'), 1);
});
