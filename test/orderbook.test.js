import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderBook } from '../exchange/orderbook.js';

let n = 0;
const order = (userId, side, price, qty, tif = 'GTC') => ({ id: `o${++n}`, userId, side, price, qty, remaining: qty, tif, status: 'new' });

test('price then time priority', () => {
  const book = new OrderBook();
  const a = order('a', 'sell', 55, 1);
  const b = order('b', 'sell', 54, 1);
  const c = order('c', 'sell', 54, 1);
  [a, b, c].forEach((o) => book.submit(o));
  assert.deepEqual(book.asks.map((o) => o.userId), ['b', 'c', 'a']);

  const { fills } = book.submit(order('x', 'buy', 55, 2));
  assert.deepEqual(fills.map((f) => [f.maker.userId, f.price]), [['b', 54], ['c', 54]]);
  assert.equal(book.bestAsk(), 55);
});

test('partial fill rests the remainder at the limit price', () => {
  const book = new OrderBook();
  book.submit(order('a', 'sell', 50, 3));
  const buy = order('x', 'buy', 52, 5);
  const { fills } = book.submit(buy);
  assert.equal(fills[0].qty, 3);
  assert.equal(fills[0].price, 50); // trades at the resting price
  assert.equal(buy.status, 'open');
  assert.equal(buy.remaining, 2);
  assert.equal(book.bestBid(), 52);
  assert.equal(book.bestAsk(), null);
});

test('IOC never rests', () => {
  const book = new OrderBook();
  book.submit(order('a', 'buy', 40, 2));
  const hit = order('x', 'sell', 40, 5, 'IOC');
  book.submit(hit);
  assert.equal(hit.status, 'cancelled');
  assert.equal(hit.remaining, 3);
  assert.equal(book.asks.length, 0);
  assert.equal(book.bids.length, 0);
});

test('self-trade prevention cancels the resting order', () => {
  const book = new OrderBook();
  const mine = order('a', 'sell', 50, 1);
  const theirs = order('b', 'sell', 51, 1);
  book.submit(mine);
  book.submit(theirs);
  const { fills, selfCancelled } = book.submit(order('a', 'buy', 51, 1));
  assert.deepEqual(selfCancelled, [mine]);
  assert.equal(fills[0].maker, theirs);
});

test('levels aggregate by price', () => {
  const book = new OrderBook();
  book.submit(order('a', 'buy', 40, 2));
  book.submit(order('b', 'buy', 40, 3));
  book.submit(order('c', 'buy', 39, 1));
  assert.deepEqual(book.levels('buy'), [
    { price: 40, qty: 5, orders: 2 },
    { price: 39, qty: 1, orders: 1 },
  ]);
  assert.deepEqual(book.levels('buy', 1), [{ price: 40, qty: 5, orders: 2 }]);
});
