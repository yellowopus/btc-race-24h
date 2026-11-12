import { BPS, runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// Dip-buy swing strategy: enter a CBBTC long when price dips at least 45bp
// below its 20-bar high while still closing above the 20-bar mean (trend
// gate). Exit on 80bp take profit, 30bp stop, or 120-bar max hold.
const SYMBOL = 'CBBTC';
const LOOKBACK = 20;
const ENTRY_DROP_BPS = 45n;
const TAKE_PROFIT_BPS = 80n;
const STOP_BPS = 30n;
const MAX_HOLD_BARS = 120;
const MAX_BUY_NOTIONAL = 900_000_000n;
const MAX_SLIPPAGE_BPS = 100;

/** CBBTC closes in the order their bars arrived, warm-up included. */
const closeHistory: bigint[] = [];
/** True after a buy order is decided on this close and before its fill is resolved. */
let hasPendingBuy = false;
/** The fill price of the open position, in price_scale units. */
let entryFillPrice: bigint | null = null;
/** Bars the position has been held through this batch's close; warm-up is never counted. */
let barsHeld = 0;

await runBars({
  onBatch(state, batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar !== undefined) closeHistory.push(BigInt(bar.c));

    // A buy decided on the previous close fills at this batch's open. Prefer the
    // reported fill price; when the batch carries no fill, fall back to this open.
    if (hasPendingBuy) {
      const fill = batch.fills.find((f) => f.symbol === SYMBOL && f.side === 'buy' && f.status === 'filled');
      if (fill !== undefined) {
        entryFillPrice = BigInt(fill.price);
      } else if (bar !== undefined && state.positions.has(SYMBOL)) {
        entryFillPrice = BigInt(bar.o);
      }
      hasPendingBuy = false;
    }

    if (state.warmingUp) return [];

    const position = state.positions.get(SYMBOL);
    if (position === undefined) {
      entryFillPrice = null;
      barsHeld = 0;
    } else {
      barsHeld += 1;
    }

    if (bar === undefined || closeHistory.length < LOOKBACK) return [];

    const lookbackCloses = closeHistory.slice(-LOOKBACK);
    const latestClose = lookbackCloses[lookbackCloses.length - 1]!;
    let highestClose = 0n;
    let closeSum = 0n;
    for (const c of lookbackCloses) {
      if (c > highestClose) highestClose = c;
      closeSum += c;
    }

    const orders: (BuyInput | SellInput)[] = [];

    if (position === undefined) {
      if (highestClose > 0n) {
        const dipBelowHighBps = ((highestClose - latestClose) * BPS) / highestClose;
        const isAboveMean = latestClose * BigInt(LOOKBACK) > closeSum;
        if (dipBelowHighBps >= ENTRY_DROP_BPS && isAboveMean) {
          const buyNotional = state.cash < MAX_BUY_NOTIONAL ? state.cash : MAX_BUY_NOTIONAL;
          orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: buyNotional, max_slippage_bps: MAX_SLIPPAGE_BPS });
          hasPendingBuy = true;
        }
      }
    } else if (entryFillPrice !== null) {
      const takeProfit = latestClose * BPS >= entryFillPrice * (BPS + TAKE_PROFIT_BPS);
      const stop = latestClose * BPS <= entryFillPrice * (BPS - STOP_BPS);
      if (takeProfit || stop || barsHeld >= MAX_HOLD_BARS) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: position.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    }

    return orders;
  },
});
