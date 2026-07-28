import test from 'node:test';
import assert from 'node:assert/strict';
import {
  base58Decode,
  base58Encode,
  decodeTokenAccountAmount,
  parseStaticWritableAccounts,
} from './curve-execution';

function fakeLegacyTransaction(): string {
  const signaturePrefix = Buffer.from([1]);
  const signature = Buffer.alloc(64);
  const header = Buffer.from([1, 0, 1]); // one signer, no readonly signer, one readonly unsigned account
  const accountCount = Buffer.from([3]);
  const payer = Buffer.alloc(32, 1);
  const writableProgramAccount = Buffer.alloc(32, 2);
  const readonlyProgram = Buffer.alloc(32, 3);
  const recentBlockhash = Buffer.alloc(32, 4);
  const instructionCount = Buffer.from([0]);
  return Buffer.concat([
    signaturePrefix, signature, header, accountCount,
    payer, writableProgramAccount, readonlyProgram,
    recentBlockhash, instructionCount,
  ]).toString('base64');
}

test('base58 codec round-trips 32-byte Solana public keys including leading zeroes', () => {
  const key = Buffer.alloc(32);
  key[30] = 7;
  key[31] = 255;
  const encoded = base58Encode(key);
  const decoded = base58Decode(encoded);
  assert.ok(decoded);
  assert.deepEqual(decoded, key);
});

test('serialized transaction parser returns payer and only writable static accounts', () => {
  const parsed = parseStaticWritableAccounts(fakeLegacyTransaction());
  assert.ok(parsed);
  assert.equal(parsed.payer, base58Encode(Buffer.alloc(32, 1)));
  assert.deepEqual(parsed.writable, [
    base58Encode(Buffer.alloc(32, 1)),
    base58Encode(Buffer.alloc(32, 2)),
  ]);
});

test('SPL token account decoder reads raw amount only for the requested mint', () => {
  const mint = Buffer.alloc(32, 9);
  const otherMint = Buffer.alloc(32, 8);
  const tokenAccount = Buffer.alloc(165);
  mint.copy(tokenAccount, 0);
  tokenAccount.writeBigUInt64LE(123456789n, 64);
  const account = { data: [tokenAccount.toString('base64'), 'base64'], lamports: 2039280 };
  assert.equal(decodeTokenAccountAmount(account, mint), 123456789n);
  assert.equal(decodeTokenAccountAmount(account, otherMint), null);
});
