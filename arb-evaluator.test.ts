import assert from 'node:assert/strict';
import test from 'node:test';
import { Decimal } from 'decimal.js';
import type { Level2TicksFromMid } from '@mysten/deepbook-v3';
import { quoteDeepBookBase } from './arb-evaluator.js';

const orderbook: Level2TicksFromMid = {
  bid_prices: [1.25, 1.2],
  bid_quantities: [2, 3],
  ask_prices: [1.3, 1.35],
  ask_quantities: [1, 4],
};

test('quotes a sell across multiple bid levels using weighted proceeds', () => {
  assert.equal(quoteDeepBookBase(orderbook, 'bid', new Decimal(4))?.toFixed(2), '4.90');
});

test('quotes a buy across multiple ask levels using weighted cost', () => {
  assert.equal(quoteDeepBookBase(orderbook, 'ask', new Decimal(3))?.toFixed(2), '4.00');
});

test('returns undefined when visible depth cannot fill the requested size', () => {
  assert.equal(quoteDeepBookBase(orderbook, 'bid', new Decimal(6)), undefined);
});

test('rejects malformed levels and incorrectly ordered books', () => {
  assert.throws(
    () => quoteDeepBookBase({ ...orderbook, bid_prices: [1.2, 1.25] }, 'bid', new Decimal(1)),
    /not ordered/,
  );
  assert.throws(
    () => quoteDeepBookBase({ ...orderbook, ask_quantities: [1] }, 'ask', new Decimal(1)),
    /different lengths/,
  );
});
