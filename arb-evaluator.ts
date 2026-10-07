import type { Level2TicksFromMid } from '@mysten/deepbook-v3';
import { Decimal } from 'decimal.js';

export type DeepBookSide = 'bid' | 'ask';

export function quoteDeepBookBase(
  orderbook: Level2TicksFromMid,
  side: DeepBookSide,
  baseAmount: Decimal,
): Decimal | undefined {
  if (!baseAmount.isFinite() || !baseAmount.isPositive()) {
    throw new Error('Requested DeepBook base amount must be a positive finite number');
  }

  const prices = side === 'bid' ? orderbook.bid_prices : orderbook.ask_prices;
  const quantities = side === 'bid' ? orderbook.bid_quantities : orderbook.ask_quantities;
  if (prices.length !== quantities.length) {
    throw new Error(`DeepBook ${side} price and quantity arrays have different lengths`);
  }

  let previousPrice: number | undefined;

  for (let i = 0; i < prices.length; i += 1) {
    const price = prices[i];
    const quantity = quantities[i];
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`DeepBook returned an invalid ${side} level at index ${i}`);
    }
    if (
      previousPrice !== undefined &&
      (side === 'bid' ? price > previousPrice : price < previousPrice)
    ) {
      throw new Error(`DeepBook ${side} levels are not ordered from best price outward`);
    }
    previousPrice = price;
  }

  let remaining = baseAmount;
  let quoteAmount = new Decimal(0);
  for (let i = 0; i < prices.length; i += 1) {
    const price = prices[i];
    const quantity = quantities[i];
    const available = new Decimal(quantity);
    const filled = Decimal.min(remaining, available);
    quoteAmount = quoteAmount.plus(filled.mul(price));
    remaining = remaining.minus(filled);
    if (remaining.isZero()) return quoteAmount;
  }

  return undefined;
}
