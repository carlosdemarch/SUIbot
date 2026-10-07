import { CetusClmmSDK } from '@cetusprotocol/sui-clmm-sdk';
import { DeepBookClient } from '@mysten/deepbook-v3';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import * as dotenv from 'dotenv';
import { Decimal } from 'decimal.js';
import { quoteDeepBookBase } from './arb-evaluator.js';

dotenv.config();

const CETUS_SUI_USDC_POOL = '0xcf994611fd4c48e277ce3ffd4d4364c914af2c3cbb05f7bf6facd371de688630';
const DEEPBOOK_POOL = 'SUI_USDC';
const ZERO_ADDRESS = `0x${'0'.repeat(64)}`;
const SUI_TYPE_SUFFIX = '::sui::sui';
const USDC_TYPE_SUFFIX = '::usdc::usdc';
const DEFAULT_TRADE_SIZES_SUI = ['0.1', '0.5', '1'];
const DEFAULT_DEEPBOOK_TICKS = 50;
const DEFAULT_MAX_SOURCE_LATENCY_MS = 5000;

type TradeDirection = 'buy_cetus_sell_deepbook' | 'buy_deepbook_sell_cetus';

type CetusQuote = {
  estimated_amount_in: string | number;
  estimated_amount_out: string | number;
  is_exceed: boolean;
};

function parsePositiveDecimalList(value: string | undefined, name: string, defaults: string[]): Decimal[] {
  const values = value?.split(',').map((item) => item.trim()) ?? defaults;
  if (values.length === 0 || values.some((item) => item.length === 0)) {
    throw new Error(`${name} must be a comma-separated list of positive numbers`);
  }

  return values.map((item) => {
    const amount = new Decimal(item);
    if (!amount.isFinite() || !amount.isPositive()) {
      throw new Error(`${name} must contain only positive finite numbers; received "${item}"`);
    }
    return amount;
  });
}

function parseNonNegativeDecimal(value: string | undefined, name: string): Decimal | undefined {
  if (value === undefined || value.trim() === '') return undefined;

  const parsed = new Decimal(value);
  if (!parsed.isFinite() || parsed.isNegative()) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
  return parsed;
}

function parsePositiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function asDecimal(value: string | number, label: string): Decimal {
  const result = new Decimal(value);
  if (!result.isFinite() || result.isNegative()) {
    throw new Error(`Cetus returned an invalid ${label}: ${value}`);
  }
  return result;
}

function toSuiBaseUnits(amount: Decimal): string {
  const baseUnits = amount.mul('1000000000');
  if (!baseUnits.isInteger()) {
    throw new Error(`TRADE_SIZES_SUI supports at most 9 decimal places: ${amount.toString()}`);
  }
  return baseUnits.toFixed(0);
}

function toUsdc(value: string | number, label: string): Decimal {
  return asDecimal(value, label).div('1000000');
}

function validatePoolTokens(coinTypeA: string, coinTypeB: string) {
  const a = coinTypeA.toLowerCase();
  const b = coinTypeB.toLowerCase();
  const suiIsA = a.endsWith(SUI_TYPE_SUFFIX);
  const suiIsB = b.endsWith(SUI_TYPE_SUFFIX);

  if (suiIsA === suiIsB) {
    throw new Error(`Cetus pool must contain exactly one SUI token: ${coinTypeA}, ${coinTypeB}`);
  }
  return {
    suiIsA,
    usdcCoinType: suiIsA ? coinTypeB : coinTypeA,
  };
}

function formatUsdc(value: Decimal): string {
  return value.toFixed(6);
}

async function quoteCetus(
  cetus: CetusClmmSDK,
  pool: Awaited<ReturnType<CetusClmmSDK['Pool']['getPool']>>,
  suiIsA: boolean,
  usdcDecimals: number,
  direction: TradeDirection,
  suiSize: Decimal,
): Promise<CetusQuote> {
  const sellingSui = direction === 'buy_deepbook_sell_cetus';
  const aToB = sellingSui ? suiIsA : !suiIsA;
  const coinTypeA = pool.coin_type_a;
  const coinTypeB = pool.coin_type_b;

  const quote = await cetus.Swap.preSwap({
    pool,
    current_sqrt_price: pool.current_sqrt_price,
    coin_type_a: coinTypeA,
    coin_type_b: coinTypeB,
    decimals_a: suiIsA ? 9 : usdcDecimals,
    decimals_b: suiIsA ? usdcDecimals : 9,
    a2b: aToB,
    by_amount_in: sellingSui,
    amount: toSuiBaseUnits(suiSize),
  });
  return quote;
}

async function evaluateSize(
  cetus: CetusClmmSDK,
  pool: Awaited<ReturnType<CetusClmmSDK['Pool']['getPool']>>,
  suiIsA: boolean,
  usdcDecimals: number,
  orderbook: Awaited<ReturnType<DeepBookClient['getLevel2TicksFromMid']>>,
  takerFeeRate: Decimal,
  size: Decimal,
  gasCostUsdc: Decimal | undefined,
  minNetProfitUsdc: Decimal,
) {
  const [cetusBuyQuote, cetusSellQuote] = await Promise.all([
    quoteCetus(cetus, pool, suiIsA, usdcDecimals, 'buy_cetus_sell_deepbook', size),
    quoteCetus(cetus, pool, suiIsA, usdcDecimals, 'buy_deepbook_sell_cetus', size),
  ]);

  const deepbookBidQuote = quoteDeepBookBase(orderbook, 'bid', size);
  const deepbookAskQuote = quoteDeepBookBase(orderbook, 'ask', size);
  const buyCetusCost = cetusBuyQuote.is_exceed
    ? undefined
    : toUsdc(cetusBuyQuote.estimated_amount_in, 'Cetus buy input');
  const sellCetusProceeds = cetusSellQuote.is_exceed
    ? undefined
    : toUsdc(cetusSellQuote.estimated_amount_out, 'Cetus sell output');

  const buyCetusSellDeepbook = deepbookBidQuote && buyCetusCost
    ? (() => {
        const deepbookFee = deepbookBidQuote.mul(takerFeeRate);
        const netBeforeGas = deepbookBidQuote.minus(deepbookFee).minus(buyCetusCost);
        const netAfterGas = gasCostUsdc ? netBeforeGas.minus(gasCostUsdc) : undefined;
        return {
          direction: 'buy_cetus_sell_deepbook' as const,
          cetusCostUsdc: buyCetusCost,
          deepbookGrossProceedsUsdc: deepbookBidQuote,
          deepbookFeeUsdc: deepbookFee,
          estimatedNetBeforeGasUsdc: netBeforeGas,
          estimatedNetAfterGasUsdc: netAfterGas,
          meetsConfiguredThreshold: netAfterGas !== undefined && netAfterGas.gte(minNetProfitUsdc),
        };
      })()
    : undefined;

  const buyDeepbookSellCetus = deepbookAskQuote && sellCetusProceeds
    ? (() => {
        const deepbookFee = deepbookAskQuote.mul(takerFeeRate);
        const netBeforeGas = sellCetusProceeds.minus(deepbookAskQuote).minus(deepbookFee);
        const netAfterGas = gasCostUsdc ? netBeforeGas.minus(gasCostUsdc) : undefined;
        return {
          direction: 'buy_deepbook_sell_cetus' as const,
          cetusGrossProceedsUsdc: sellCetusProceeds,
          deepbookCostUsdc: deepbookAskQuote,
          deepbookFeeUsdc: deepbookFee,
          estimatedNetBeforeGasUsdc: netBeforeGas,
          estimatedNetAfterGasUsdc: netAfterGas,
          meetsConfiguredThreshold: netAfterGas !== undefined && netAfterGas.gte(minNetProfitUsdc),
        };
      })()
    : undefined;

  return {
    size,
    cetusBuyExceeds: cetusBuyQuote.is_exceed,
    cetusSellExceeds: cetusSellQuote.is_exceed,
    deepbookBidInsufficient: deepbookBidQuote === undefined,
    deepbookAskInsufficient: deepbookAskQuote === undefined,
    buyCetusSellDeepbook,
    buyDeepbookSellCetus,
  };
}

async function main() {
  const rpcUrl = process.env.RPC_URL || 'https://fullnode.mainnet.sui.io:443';
  const tradeSizes = parsePositiveDecimalList(
    process.env.TRADE_SIZES_SUI,
    'TRADE_SIZES_SUI',
    DEFAULT_TRADE_SIZES_SUI,
  );
  const gasCostUsdc = parseNonNegativeDecimal(process.env.GAS_COST_USDC, 'GAS_COST_USDC');
  const minNetProfitUsdc = parseNonNegativeDecimal(
    process.env.MIN_NET_PROFIT_USDC,
    'MIN_NET_PROFIT_USDC',
  ) ?? new Decimal(0);
  const deepbookTicks = parsePositiveInteger(
    process.env.DEEPBOOK_TICKS,
    'DEEPBOOK_TICKS',
    DEFAULT_DEEPBOOK_TICKS,
  );
  const maxSourceLatencyMs = parsePositiveInteger(
    process.env.MAX_SOURCE_LATENCY_MS,
    'MAX_SOURCE_LATENCY_MS',
    DEFAULT_MAX_SOURCE_LATENCY_MS,
  );
  const senderAddress = process.env.SUI_ADDRESS || ZERO_ADDRESS;
  const client = new SuiGrpcClient({ baseUrl: rpcUrl, network: 'mainnet' });
  const cetus = CetusClmmSDK.createSDK({ env: 'mainnet', sui_client: client });
  const deepbook = new DeepBookClient({
    client,
    network: 'mainnet',
    address: senderAddress,
  });

  console.log('--- Read-only SUI/USDC arbitrage monitor ---');
  console.log('Execution is disabled; this process only fetches and evaluates quotes.');
  if (!gasCostUsdc) {
    console.warn('GAS_COST_USDC is unset: results exclude gas and cannot meet a net-profit threshold.');
  }

  const scanStartedAt = performance.now();
  const [poolResponse, orderbookResponse, tradeParamsResponse] = await Promise.all([
    cetus.Pool.getPool(CETUS_SUI_USDC_POOL).then((data) => ({
      data,
      receivedAt: Date.now(),
      latencyMs: performance.now() - scanStartedAt,
    })),
    deepbook.getLevel2TicksFromMid(DEEPBOOK_POOL, deepbookTicks).then((data) => ({
      data,
      receivedAt: Date.now(),
      latencyMs: performance.now() - scanStartedAt,
    })),
    deepbook.poolTradeParams(DEEPBOOK_POOL),
  ]);

  if (poolResponse.latencyMs > maxSourceLatencyMs || orderbookResponse.latencyMs > maxSourceLatencyMs) {
    throw new Error(
      `Source response exceeded MAX_SOURCE_LATENCY_MS (${maxSourceLatencyMs} ms); ` +
      `Cetus=${poolResponse.latencyMs.toFixed(0)} ms, DeepBook=${orderbookResponse.latencyMs.toFixed(0)} ms`,
    );
  }

  const pool = poolResponse.data;
  const { suiIsA, usdcCoinType } = validatePoolTokens(pool.coin_type_a, pool.coin_type_b);
  const usdcMetadataResponse = await client.core.getCoinMetadata({ coinType: usdcCoinType });
  const usdcMetadata = usdcMetadataResponse.coinMetadata;
  if (usdcMetadata?.symbol.toUpperCase() !== 'USDC') {
    throw new Error(`Cetus pool's non-SUI token is not verified as USDC: ${usdcCoinType}`);
  }
  if (usdcMetadata.decimals !== 6) {
    throw new Error(`Expected a 6-decimal USDC asset, got ${usdcMetadata.decimals} decimals`);
  }
  const takerFeeRate = new Decimal(tradeParamsResponse.takerFee);
  if (!takerFeeRate.isFinite() || takerFeeRate.isNegative() || takerFeeRate.gte(1)) {
    throw new Error(`DeepBook returned an invalid taker fee rate: ${tradeParamsResponse.takerFee}`);
  }

  console.log(`Cetus pool fee: ${(pool.fee_rate / 1_000_000 * 10_000).toFixed(2)} bps`);
  console.log(`DeepBook taker fee: ${takerFeeRate.mul(10_000).toFixed(2)} bps`);
  console.log(`Cetus pool response: ${new Date(poolResponse.receivedAt).toISOString()} (${poolResponse.latencyMs.toFixed(0)} ms)`);
  console.log(`DeepBook book response: ${new Date(orderbookResponse.receivedAt).toISOString()} (${orderbookResponse.latencyMs.toFixed(0)} ms)`);
  console.log(`Estimated gas cost: ${gasCostUsdc ? `$${formatUsdc(gasCostUsdc)} USDC` : 'not configured'}`);
  console.log(`Minimum net profit: $${formatUsdc(minNetProfitUsdc)} USDC`);
  console.log('Response timestamps are local receipt times, not on-chain quote timestamps.');

  const results = await Promise.all(tradeSizes.map((size) =>
    evaluateSize(
      cetus,
      pool,
      suiIsA,
      usdcMetadata.decimals,
      orderbookResponse.data,
      takerFeeRate,
      size,
      gasCostUsdc,
      minNetProfitUsdc,
    ),
  ));

  for (const result of results) {
    console.log(`\n--- Size: ${result.size.toString()} SUI ---`);
    if (!result.buyCetusSellDeepbook) {
      const reason = [
        result.cetusBuyExceeds ? 'Cetus cannot quote the requested output size' : undefined,
        result.deepbookBidInsufficient ? 'insufficient visible DeepBook bid depth' : undefined,
      ].filter(Boolean).join('; ') || 'quote unavailable';
      console.log(`Buy Cetus / sell DeepBook unavailable: ${reason}.`);
    } else {
      const route = result.buyCetusSellDeepbook;
      console.log(
        `Buy Cetus / sell DeepBook: Cetus cost $${formatUsdc(route.cetusCostUsdc)}, ` +
        `DeepBook proceeds $${formatUsdc(route.deepbookGrossProceedsUsdc)}, ` +
        `DeepBook fee $${formatUsdc(route.deepbookFeeUsdc)}, ` +
        `estimated net before gas $${formatUsdc(route.estimatedNetBeforeGasUsdc)}`,
      );
      if (route.estimatedNetAfterGasUsdc) {
        console.log(`Estimated net after configured gas: $${formatUsdc(route.estimatedNetAfterGasUsdc)}`);
        console.log(`Meets configured threshold: ${route.meetsConfiguredThreshold}`);
      }
    }

    if (!result.buyDeepbookSellCetus) {
      const reason = [
        result.deepbookAskInsufficient ? 'insufficient visible DeepBook ask depth' : undefined,
        result.cetusSellExceeds ? 'Cetus cannot quote the requested input size' : undefined,
      ].filter(Boolean).join('; ') || 'quote unavailable';
      console.log(`Buy DeepBook / sell Cetus unavailable: ${reason}.`);
    } else {
      const route = result.buyDeepbookSellCetus;
      console.log(
        `Buy DeepBook / sell Cetus: DeepBook cost $${formatUsdc(route.deepbookCostUsdc)}, ` +
        `DeepBook fee $${formatUsdc(route.deepbookFeeUsdc)}, ` +
        `Cetus proceeds $${formatUsdc(route.cetusGrossProceedsUsdc)}, ` +
        `estimated net before gas $${formatUsdc(route.estimatedNetBeforeGasUsdc)}`,
      );
      if (route.estimatedNetAfterGasUsdc) {
        console.log(`Estimated net after configured gas: $${formatUsdc(route.estimatedNetAfterGasUsdc)}`);
        console.log(`Meets configured threshold: ${route.meetsConfiguredThreshold}`);
      }
    }
  }

  console.log(`\nScan completed in ${(performance.now() - scanStartedAt).toFixed(0)} ms.`);
  console.log('These are estimates from independently sampled venues, not execution guarantees.');
}

main().catch((error: unknown) => {
  console.error('Arbitrage monitor failed:', error);
  process.exitCode = 1;
});
