#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// generate_keys.js — Generate Asymmetric Keypair for OTA Patch Signing
//
// Usage:
//   node tools/generate_keys.js [--type rsa|ec] [--out <dir>]
//   e.g. node tools/generate_keys.js
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let keyType = 'rsa';
let outDir = process.cwd();

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--type' && args[i + 1]) {
    keyType = args[i + 1].toLowerCase();
    i++;
  } else if (args[i] === '--out' && args[i + 1]) {
    outDir = path.resolve(args[i + 1]);
    i++;
  }
}

console.log(`\n=== Generating ${keyType.toUpperCase()} Keypair for OTA Patch Security ===\n`);

let privateKey, publicKey;

if (keyType === 'ec') {
  const keypair = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  privateKey = keypair.privateKey;
  publicKey = keypair.publicKey;
} else {
  // Default: RSA 2048
  const keypair = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  privateKey = keypair.privateKey;
  publicKey = keypair.publicKey;
}

const privPath = path.join(outDir, 'ota_private_key.pem');
const pubPath = path.join(outDir, 'ota_public_key.pem');

fs.writeFileSync(privPath, privateKey, { mode: 0o600 });
fs.writeFileSync(pubPath, publicKey, { mode: 0o644 });

// Clean public key string for inline JS config
const pubKeyClean = publicKey
  .replace(/-----BEGIN PUBLIC KEY-----/, '')
  .replace(/-----END PUBLIC KEY-----/, '')
  .replace(/\s+/g, '');

console.log(`  ✓ Private Key saved to: ${privPath}`);
console.log(`  ✓ Public Key saved to:  ${pubPath}`);
console.log('\n────────────────────────────────────────────────────────');
console.log('  HOW TO USE:');
console.log('  1. KEEP PRIVATE KEY SAFE on your build machine / CI server:');
console.log('     Add "ota_private_key.pem" to .gitignore!');
console.log('');
console.log('  2. ADD PUBLIC KEY TO YOUR CLIENT APP CONFIG:');
console.log('     const otaConfig: OtaConfig = {');
console.log(`       publicKey: '${pubKeyClean}',`);
console.log('       ...');
console.log('     };');
console.log('────────────────────────────────────────────────────────\n');
