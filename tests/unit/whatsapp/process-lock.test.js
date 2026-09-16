const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createProcessLock, ProcessLockError } = require('../../../src/whatsapp/process-lock');

function temporaryLockPath() {
  return path.join(os.tmpdir(), `wa-process-lock-${process.pid}-${Math.random()}.lock`);
}

test('allows one owner and rejects a second bot instance', () => {
  const lockPath = temporaryLockPath();
  const first = createProcessLock(lockPath);
  const second = createProcessLock(lockPath);

  try {
    first.acquire();
    assert.throws(() => second.acquire(), error => {
      assert.equal(error instanceof ProcessLockError, true);
      assert.equal(error.code, 'BOT_ALREADY_RUNNING');
      assert.equal(error.ownerPid, process.pid);
      return true;
    });
  } finally {
    first.release();
    second.release();
    fs.rmSync(lockPath, { force: true });
  }
});

test('recovers a stale lock marker after the previous process is gone', () => {
  const lockPath = temporaryLockPath();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, '999999999\n', { mode: 0o600 });
  const lock = createProcessLock(lockPath);

  try {
    lock.acquire();
    assert.equal(fs.readFileSync(lockPath, 'utf8').trim(), String(process.pid));
  } finally {
    lock.release();
    fs.rmSync(lockPath, { force: true });
  }
});
