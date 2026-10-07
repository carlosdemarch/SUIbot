# Sui SUI/USDC read-only arbitrage monitor

This project currently monitors quotes only. It does not sign transactions or submit trades.

Run continuous scans with `npm start` and the focused evaluator tests with `npm test`.
Scans run sequentially, with a 10-second pause after each scan by default. Set
`SCAN_INTERVAL_MS` to change the pause.

The monitor:

- Gets a Cetus pool snapshot and DeepBook order-book depth concurrently.
- Requests exact-size Cetus swap quotes and calculates DeepBook proceeds/cost across visible levels.
- Uses DeepBook's current pool taker-fee parameter and subtracts it from the estimated route P&L.
- Reports estimated net before gas. Set `GAS_COST_USDC` to also see estimated net after gas.

## Configuration

Set optional values in `.env`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `RPC_URL` | Sui mainnet fullnode | RPC endpoint used by both SDKs |
| `SUI_ADDRESS` | Zero address | Sender for read-only simulations; no private key is loaded |
| `TRADE_SIZES_SUI` | `0.1,0.5,1` | Candidate SUI sizes to quote |
| `DEEPBOOK_TICKS` | `50` | Number of DeepBook price ticks around mid to request |
| `MAX_SOURCE_LATENCY_MS` | `5000` | Reject a scan if either initial market-data response takes longer |
| `SCAN_INTERVAL_MS` | `10000` | Pause between completed scans |
| `GAS_COST_USDC` | Unset | Estimated total transaction gas cost in USDC |
| `MIN_NET_PROFIT_USDC` | `0` | Minimum estimated P&L after configured gas |

Without `GAS_COST_USDC`, the output deliberately does not report whether a route meets the configured threshold. Response timestamps are local receipt times, not on-chain timestamps. Quotes from the two venues are not atomic, so displayed P&L is indicative and is not an execution guarantee.

Do not treat a displayed positive estimate as a trade signal. Validate fee treatment, quote accuracy, depth, and gas against simulations before adding any execution code.
