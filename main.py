import os
import sys
from fractions import Fraction

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))

import makefun_bars

SYMBOL = "CBBTC"
FAST_SPAN = 40
SLOW_SPAN = 240
REGIME_THRESHOLD_BPS = 2
TRAIL_BPS = 80
MAX_BUY_NOTIONAL = 900_000_000
BPS = 10_000


class Trader:
    def __init__(self):
        self.ema_fast = None
        self.ema_slow = None
        self.peak = None

    def update(self, close):
        if self.ema_fast is None:
            self.ema_fast = Fraction(close)
            self.ema_slow = Fraction(close)
        else:
            self.ema_fast += Fraction(2, FAST_SPAN + 1) * (Fraction(close) - self.ema_fast)
            self.ema_slow += Fraction(2, SLOW_SPAN + 1) * (Fraction(close) - self.ema_slow)

    def on_batch(self, state, batch):
        close = state.close(SYMBOL)
        if close is None:
            return []

        self.update(close)
        holding = state.positions.get(SYMBOL)

        if holding is None:
            if self.ema_fast > self.ema_slow:
                spread = (self.ema_fast - self.ema_slow) / Fraction(close)
                if spread > Fraction(REGIME_THRESHOLD_BPS, BPS):
                    notional = min(MAX_BUY_NOTIONAL, state.cash)
                    if notional > 0:
                        self.peak = close
                        return [{
                            "side": "buy",
                            "symbol": SYMBOL,
                            "notional_quote_units": notional,
                            "max_slippage_bps": 100,
                        }]
            return []

        if self.peak is None:
            self.peak = close
        if close > self.peak:
            self.peak = close

        if self.ema_fast < self.ema_slow or close * BPS < self.peak * (BPS - TRAIL_BPS):
            return [{
                "side": "sell",
                "symbol": SYMBOL,
                "qty": holding.qty,
                "max_slippage_bps": 100,
            }]
        return []


trader = Trader()


def on_batch(state, batch):
    return trader.on_batch(state, batch)


if __name__ == "__main__":
    makefun_bars.run(on_batch)
