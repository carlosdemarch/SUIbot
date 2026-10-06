import { SuiGrpcClient } from '@mysten/sui/grpc';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { DeepBookClient } from '@mysten/deepbook-v3';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import * as dotenv from 'dotenv';

dotenv.config();

const CETUS_SUI_USDC_POOL = '0xcf994611fd4c48e277ce3ffd4d4364c914af2c3cbb05f7bf6facd371de688630';

async function main() {
    console.log('--- Initializing Market Fetcher ---');

    // 1. Core RPC Client (for execution and DeepBook)
    const rpcUrl = process.env.RPC_URL || 'https://fullnode.mainnet.sui.io:443';
    const client = new SuiGrpcClient({ baseUrl: rpcUrl, network: 'mainnet' });

    // 2. Core GraphQL Client (Bypasses BCS bytes, parses Move objects to JSON)
    const gqlClient = new SuiGraphQLClient({
        url: 'https://graphql.mainnet.sui.io/graphql', // Updated to official mainnet URL
    });

    // 3. Load Bot Address
    if (!process.env.SUI_PRIVATE_KEY) {
        throw new Error("SUI_PRIVATE_KEY is missing in .env file");
    }
    const keypair = Ed25519Keypair.fromSecretKey(process.env.SUI_PRIVATE_KEY);
    const botAddress = keypair.toSuiAddress();

    // 4. Initialize DeepBook V3 SDK
    const deepbook = new DeepBookClient({
        client: client as any, 
        network: 'mainnet', 
        address: botAddress 
    });

    console.log('Clients initialized. Fetching live pool data...\n');

    try {
        console.time('Fetch Time'); 

        // --- CETUS (SUI/USDC) via GraphQL ---
        console.log('--- CETUS (SUI/USDC) ---');
        
        // Direct GraphQL query to ask the server for the un-compiled JSON
        const cetusQuery = await gqlClient.query({
            query: `
                query {
                    object(address: "${CETUS_SUI_USDC_POOL}") {
                        asMoveObject {
                            contents {
                                json
                            }
                        }
                    }
                }
            `
        });
        
        const cetusData = (cetusQuery.data as any)?.object?.asMoveObject?.contents?.json;
        if (cetusData) {
            const tick = cetusData.current_tick_index?.fields?.bits || cetusData.current_tick_index;
            console.log(`Current Tick: ${tick}`);
            console.log(`Sqrt Price: ${cetusData.current_sqrt_price}`);
        } else {
            console.log('Could not parse Cetus Pool JSON. Raw Data:', JSON.stringify(cetusQuery, null, 2));
        }

        // --- DEEPBOOK V3 (SUI/USDC) ---
        console.log('\n--- DEEPBOOK V3 (SUI/USDC) ---');
        
        // V3 strictly requires positional arguments with this specific string
        const orderbook = await deepbook.getLevel2TicksFromMid('SUI_USDC', 5);
        
        console.dir(orderbook, { depth: null, colors: true });

        console.log('\n');
        console.timeEnd('Fetch Time');

    } catch (error) {
        console.error('\nError fetching market data. Details:', error);
    }
}

main().catch(console.error);
