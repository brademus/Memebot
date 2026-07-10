// pump.fun bonding-curve constants — ONE source of truth.
// These were previously hardcoded inconsistently across score.ts (85 SOL / 69000
// USD / bare 34 & 30), states.ts (bare 34), and config.yaml (69 SOL). When they
// disagree, graduation-proximity scoring, curve-dump death detection, and the
// LITE progress proxy all measure against different finish lines. Fixed here.
//
// pump.fun's graduation is denominated in ~$69K of bonding-curve progress, which
// at typical SOL prices is ~85 SOL of virtual reserves over a ~30 SOL virtual
// start. We express thresholds as FRACTIONS of curve progress so they hold
// regardless of the SOL price of the day.
export const CURVE_START_SOL = 30;         // virtual SOL reserve at mint
export const GRADUATION_SOL = 85;          // virtual SOL reserve at graduation
export const GRADUATION_MCAP_USD = 69000;  // the dollar-denominated finish line
export const CURVE_SPAN_SOL = GRADUATION_SOL - CURVE_START_SOL;  // 55

// A curve is "meaningfully filled" past this — below it, drawdown %s are noise
// on near-empty reserves. (Was the bare literal 34 in two files.)
export const CURVE_FILLED_SOL = CURVE_START_SOL + 4;  // 34

// fraction-of-span helpers
export const curveProgress = (sol: number) => Math.max(0, Math.min(1, (sol - CURVE_START_SOL) / CURVE_SPAN_SOL));
