import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import * as dotenv from 'dotenv';

dotenv.config();

async function main() {
    console.log('--- Initializing Bot Environment ---');

    // 1. Setup Client
    const rpcUrl = process.env.RPC_URL || 'https://fullnode.mainnet.sui.io:443';
    const client = new SuiGrpcClient({ 
        baseUrl: rpcUrl, 
        network: 'mainnet' 
    });

    // 2. Setup Wallet from Secret Key
    if (!process.env.SUI_PRIVATE_KEY) {
        throw new Error("SUI_PRIVATE_KEY is missing in .env file");
    }
    const keypair = Ed25519Keypair.fromSecretKey(process.env.SUI_PRIVATE_KEY);
    const botAddress = keypair.toSuiAddress();
    console.log(`Bot Address: ${botAddress}`);

    // 3. Verify Balance
    const { balance } = await client.getBalance({ owner: botAddress });
    const suiBalance = Number(balance.balance) / 1_000_000_000;
    console.log(`Current Balance: ${suiBalance} SUI`);

    // 4. Build Test PTB
    const tx = new Transaction();
    tx.setSender(botAddress);
    
    const [splitCoin] = tx.splitCoins(tx.gas, [10_000_000]); 
    tx.transferObjects([splitCoin], botAddress);

    // 5. Simulate Transaction
    console.log('Building and Simulating PTB...');
    const buildBytes = await tx.build({ client });
    const simulateRes = await client.simulateTransaction({ transaction: buildBytes });

    // Print the entire raw object to inspect the new structure
    console.log('\n--- Full Simulation Response ---');
    console.dir(simulateRes, { depth: null, colors: true });
}

main().catch(console.error);
