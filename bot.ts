import { SuiGrpcClient } from '@mysten/sui/grpc';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { DeepBookClient } from '@mysten/deepbook-v3';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import * as dotenv from 'dotenv';
import Decimal from 'decimal.js';

dotenv.config();

const CETUS_SUI_USDC_POOL = '0xcf994611fd4c48e277ce3ffd4d4364c914af2c3cbb05f7bf6facd371de688630';

// Math Module for Q64.64 conversion
function getCetusPrice(sqrtPriceX64: string): number {
  const sqrtPrice = new Decimal(sqrtPriceX64);
  const q64 = new Decimal(2).pow(64);
  const priceRaw = sqrtPrice.div(q64).pow(2);
  const decimalsAdjustment = new Decimal(1000); // 10^9 / 10^6
  const price = priceRaw.div(decimalsAdjustment);
  return new Decimal(1).div(price).toNumber();
}

async function main() {
    console.log('--- Initializing Arbitrage Engine ---');

    const rpcUrl = process.env.RPC_URL || 'https://fullnode.mainnet.sui.io:443';
    const client = new SuiGrpcClient({ baseUrl: rpcUrl, network: 'mainnet' });

    const gqlClient = new SuiGraphQLClient({
        url: 'https://graphql.mainnet.sui.io/graphql',
    });

    if (!process.env.SUI_PRIVATE_KEY) {
        throw new Error("SUI_PRIVATE_KEY is missing in .env file");
    }
    const keypair = Ed25519Keypair.fromSecretKey(process.env.SUI_PRIVATE_KEY);
    const botAddress = keypair.toSuiAddress();

    const deepbook = new DeepBookClient({
        client: client as any, 
        network: 'mainnet', 
        address: botAddress 
    });

    console.log('Engine initialized. Scanning for spreads...\n');

    try {
        console.time('Scan Latency'); 

        // 1. Fetch Cetus Pool Data
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
        if (!cetusData) throw new Error('Failed to fetch Cetus Data');
        
        if (!cetusData?.current_sqrt_price) {
          throw new Error('Missing current_sqrt_price from Cetus pool');
        }

        const cetusPrice = getCetusPrice(cetusData.current_sqrt_price);

        if (!Number.isFinite(cetusPrice) || cetusPrice <= 0) {
          throw new Error(`Invalid Cetus price: ${cetusPrice}`);
        }

        // 2. Fetch DeepBook Data
        const orderbook = await deepbook.getLevel2TicksFromMid('SUI_USDC', 5) as any;
        const bid = orderbook?.bid_prices?.[0];
        const ask = orderbook?.ask_prices?.[0];

        if (bid == null || ask == null) {
          throw new Error('DeepBook lacks bid/ask liquidity');
        }

        // 3. Output Prices
        console.log('--- LIVE MARKET PRICES ---');
        console.log(`Cetus Price:  $${cetusPrice.toFixed(5)}`);
        console.log(`DeepBook Bid: $${bid.toFixed(5)}`);
        console.log(`DeepBook Ask: $${ask.toFixed(5)}`);
        console.log('--------------------------');

        // 4. Spread Detection Logic
        if (bid > cetusPrice) {
            const spread = bid - cetusPrice;
            const profitBps = (spread / cetusPrice) * 10000;
            console.log(`🟢 ARB OPPORTUNITY: Buy on Cetus, Sell on DeepBook!`);
            console.log(`Gross Spread: $${spread.toFixed(5)} per SUI (${profitBps.toFixed(2)} bps)`);
        } else if (cetusPrice > ask) {
            const spread = cetusPrice - ask;
            const profitBps = (spread / ask) * 10000;
            console.log(`🟢 ARB OPPORTUNITY: Buy on DeepBook, Sell on Cetus!`);
            console.log(`Gross Spread: $${spread.toFixed(5)} per SUI (${profitBps.toFixed(2)} bps)`);
        } else {
            console.log(`🔴 No profitable arbitrage spread right now.`);
        }

        console.log('\n');
        console.timeEnd('Scan Latency');

    } catch (error) {
        console.error('\nEngine Error:', error);
    }
}

main().catch(console.error);

type ArbDecision =
  | { direction: 'buy_cetus_sell_deepbook'; grossSpreadBps: number; netSpreadBps: number; trade: true; }
  | { direction: 'buy_deepbook_sell_cetus'; grossSpreadBps: number; netSpreadBps: number; trade: true; }
  | { trade: false; grossSpreadBps: number; netSpreadBps: number; reason: string };

function evaluateArbOpportunity(
  cetusPrice: number,
  deepbookBid: number,
  deepbookAsk: number,
  options?: {
    takerFeeBps?: number;
    slippageBps?: number;
    gasBps?: number;
    safetyBufferBps?: number;
  }
): ArbDecision {
  const takerFeeBps = options?.takerFeeBps ?? 8;
  const slippageBps = options?.slippageBps ?? 10;
  const gasBps = options?.gasBps ?? 5;
  const safetyBufferBps = options?.safetyBufferBps ?? 10;

  const minRequiredGrossBps =
    takerFeeBps + slippageBps + gasBps + safetyBufferBps;

  if (deepbookBid > cetusPrice) {
    const grossSpread = deepbookBid - cetusPrice;
    const grossSpreadBps = (grossSpread / cetusPrice) * 10000;
    const netSpreadBps = grossSpreadBps - minRequiredGrossBps;

    if (grossSpreadBps > minRequiredGrossBps) {
      return {
        direction: 'buy_cetus_sell_deepbook',
        grossSpreadBps,
        netSpreadBps,
        trade: true,
      };
    }

    return {
      trade: false,
      grossSpreadBps,
      netSpreadBps,
      reason: `Gross spread ${grossSpreadBps.toFixed(2)} bps is below minimum ${minRequiredGrossBps.toFixed(2)} bps`,
    };
  }

  if (cetusPrice > deepbookAsk) {
    const grossSpread = cetusPrice - deepbookAsk;
    const grossSpreadBps = (grossSpread / deepbookAsk) * 10000;
    const netSpreadBps = grossSpreadBps - minRequiredGrossBps;

    if (grossSpreadBps > minRequiredGrossBps) {
      return {
        direction: 'buy_deepbook_sell_cetus',
        grossSpreadBps,
        netSpreadBps,
        trade: true,
      };
    }

    return {
      trade: false,
      grossSpreadBps,
      netSpreadBps,
      reason: `Gross spread ${grossSpreadBps.toFixed(2)} bps is below minimum ${minRequiredGrossBps.toFixed(2)} bps`,
    };
  }

  return {
    trade: false,
    grossSpreadBps: 0,
    netSpreadBps: 0,
    reason: 'No spread',
  };
}