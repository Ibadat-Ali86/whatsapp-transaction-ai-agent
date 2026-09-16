const fs = require('fs');
const path = require('path');

class ProcessLockError extends Error {
  constructor(lockPath, ownerPid = null) {
    const ownerText = Number.isInteger(ownerPid) ? ` (owner PID ${ownerPid})` : '';
    super(`Another bot process already owns ${lockPath}${ownerText}`);
    this.name = 'ProcessLockError';
    this.code = 'BOT_ALREADY_RUNNING';
    this.lockPath = lockPath;
    this.ownerPid = ownerPid;
  }
}

function readOwnerPid(lockPath) {
  try {
    const value = Number.parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return null;
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function createProcessLock(filePath = 'data/whatsapp-bot.lock') {
  const lockPath = path.resolve(filePath);
  let fileDescriptor = null;
  let acquired = false;

  const acquire = () => {
    if (acquired) return;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });

    try {
      fileDescriptor = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeSync(fileDescriptor, `${process.pid}\n`);
      acquired = true;
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    const ownerPid = readOwnerPid(lockPath);
    if (ownerPid && processExists(ownerPid)) {
      throw new ProcessLockError(lockPath, ownerPid);
    }

    // A crashed process can leave only its marker behind. Remove that stale
    // marker and retry once; the exclusive create keeps concurrent starters
    // from both claiming the lock.
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    try {
      fileDescriptor = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeSync(fileDescriptor, `${process.pid}\n`);
      acquired = true;
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new ProcessLockError(lockPath, readOwnerPid(lockPath));
      }
      throw error;
    }
  };

  const release = () => {
    if (fileDescriptor !== null) {
      try {
        fs.closeSync(fileDescriptor);
      } catch (_error) {
        // The descriptor may already have been closed during process exit.
      }
      fileDescriptor = null;
    }

    if (!acquired) return;
    acquired = false;
    if (readOwnerPid(lockPath) !== process.pid) return;
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  };

  return Object.freeze({ acquire, release, path: lockPath });
}

module.exports = { createProcessLock, ProcessLockError };
