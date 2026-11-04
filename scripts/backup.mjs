#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, chmodSync, copyFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';

// VACUUM INTO takes a consistent SQLite snapshot, including committed WAL data.
// No provider credentials are printed. Protect the resulting directory as a secret.
const source = resolve(process.argv[2] || process.env.DATA_DIR || 'data');
const parent = resolve(process.argv[3] || 'backups');
const dbFile = join(source, 'aperture.sqlite');
const keyFile = join(source, 'encryption.key');
const suppliedKey = process.env.ENCRYPTION_KEY;
if (!existsSync(dbFile)) throw new Error(`Database not found: ${dbFile}`);
if (suppliedKey && !/^[a-f\d]{64}$/i.test(suppliedKey)) throw new Error('ENCRYPTION_KEY must be 64 hexadecimal characters.');
if (!suppliedKey && !existsSync(keyFile)) throw new Error('The encryption key is missing. Load the original ENCRYPTION_KEY environment value or restore encryption.key before backing up.');
const destination = join(parent, `aperture-${new Date().toISOString().replaceAll(':', '-')}-${randomBytes(3).toString('hex')}`);
mkdirSync(destination, { recursive: true, mode: 0o700 });
chmodSync(destination, 0o700);
const db = new DatabaseSync(dbFile, { readOnly: true });
try {
  db.exec('PRAGMA busy_timeout=10000');
  db.prepare('VACUUM INTO ?').run(join(destination, 'aperture.sqlite'));
} finally {
  db.close();
}
chmodSync(join(destination, 'aperture.sqlite'), 0o600);
if (suppliedKey) {
  writeFileSync(join(destination, 'encryption-key.hex'), suppliedKey, { mode: 0o600 });
} else {
  copyFileSync(keyFile, join(destination, 'encryption.key'));
  chmodSync(join(destination, 'encryption.key'), 0o600);
}
writeFileSync(join(destination, 'backup.json'), JSON.stringify({ version: 1, createdAt: new Date().toISOString(), keyMode: suppliedKey ? 'environment' : 'file', database: 'aperture.sqlite' }, null, 2) + '\n', { mode: 0o600 });
console.log(`Backup saved to ${destination}`);
console.log('Keep this directory private: it contains the database and the key needed to decrypt connections.');
