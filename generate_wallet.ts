import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

// Generate a random Ed25519 keypair
const keypair = new Ed25519Keypair();

console.log('--- New Bot Wallet Generated ---');
console.log('Public Address:', keypair.toSuiAddress());
console.log('Private Key (SUI_PRIVATE_KEY):', keypair.getSecretKey());
console.log('\n⚠️ ACTION REQUIRED:');
console.log('1. Copy the Private Key above.');
console.log('2. Paste it into your .env file as SUI_PRIVATE_KEY=suiprivkey...');
