import { BPS, runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const LOOKBACK = 20;
const ENTRY_DROP_BPS = 45n;
const TAKE_PROFIT_BPS = 80n;
const STOP_BPS = 30n;
const MAX_HOLD_BARS = 120;
const MAX_BUY_NOTIONAL = 900_000_000n;
const MAX_SLIPPAGE_BPS = 100;

/** CBBTC closes in the order their bars arrived, warm-up included. */
const closes: bigint[] = [];
/** True after a buy order is decided on this close and before its fill is resolved. */
let pendingBuy = false;
/** The fill price of the open position, in price_scale units. */
let entryFill: bigint | null = null;
/** Bars the position has been held through this batch's close; warm-up is never counted. */
let barsHeld = 0;

await runBars({
  onBatch(state, batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar !== undefined) closes.push(BigInt(bar.c));

    // A buy decided on the previous close fills at this batch's open. Prefer the
    // reported fill price; when the batch carries no fill, fall back to this open.
    if (pendingBuy) {
      const fill = batch.fills.find((f) => f.symbol === SYMBOL && f.side === 'buy' && f.status === 'filled');
      if (fill !== undefined) {
        entryFill = BigInt(fill.price);
      } else if (bar !== undefined && state.positions.has(SYMBOL)) {
        entryFill = BigInt(bar.o);
      }
      pendingBuy = false;
    }

    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    if (held === undefined) {
      entryFill = null;
      barsHeld = 0;
    } else {
      barsHeld += 1;
    }

    if (bar === undefined || closes.length < LOOKBACK) return [];

    const windowCloses = closes.slice(-LOOKBACK);
    const close = windowCloses[windowCloses.length - 1]!;
    let maxClose = 0n;
    let sum = 0n;
    for (const c of windowCloses) {
      if (c > maxClose) maxClose = c;
      sum += c;
    }

    const orders: (BuyInput | SellInput)[] = [];

    if (held === undefined) {
      if (maxClose > 0n) {
        const dropBps = ((maxClose - close) * BPS) / maxClose;
        const aboveMean = close * BigInt(LOOKBACK) > sum;
        if (dropBps >= ENTRY_DROP_BPS && aboveMean) {
          const notional = state.cash < MAX_BUY_NOTIONAL ? state.cash : MAX_BUY_NOTIONAL;
          orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
          pendingBuy = true;
        }
      }
    } else if (entryFill !== null) {
      const takeProfit = close * BPS >= entryFill * (BPS + TAKE_PROFIT_BPS);
      const stop = close * BPS <= entryFill * (BPS - STOP_BPS);
      if (takeProfit || stop || barsHeld >= MAX_HOLD_BARS) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    }

    return orders;
  },
});
