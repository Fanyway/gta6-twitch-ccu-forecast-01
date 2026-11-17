# gta6-twitch-ccu-forecast-01

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/Fanyway/gta6-twitch-ccu-forecast-01/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/Fanyway/gta6-twitch-ccu-forecast-01/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

Forecast how many people watch Grand Theft Auto VI live on Twitch in each
hour of its release day (2026-11-19 UTC), hours 2–24, as five quantiles each.
`main.ts` (Node 22, standard library only, no network) reads one case file
and writes one forecast file. Scored by mean pinball loss on the log scale;
a prize needs a loss strictly below the best house entry.

## The model

An hourly profile learned at run time from the case's own `comparables`
(past big launches' hourly Twitch counts), not hard-coded from any launch:

1. **Shape set** — console-only, rolling-midnight-local launches (no PC,
   no simultaneous global unlock, no early access): the games shaped most
   like GTA VI, which unlocks at midnight local on PS5/Xbox.
2. **Similarity** — `x = ln(hour-1 print / pre-launch max)`: how much of the
   game's recent buzz hour 1 already holds. A small hour 1 next to big buzz
   means the West has not woken up yet and the day rises much further (the
   correlation across comparables is about −0.8). Each hour's median is a
   Gaussian-kernel weighted median of the shape set's log-ratios to hour 1,
   with the kernel over `x`, so launches that looked like the target at
   hour 1 count most.
3. **Spread** — the weighted interquartile range of the same log-ratios,
   floored at 0.5 log units, so the 90% band stays honest even when the
   shape set agrees closely.
4. **Extreme hour 1** — when `x` is below −0.8 the shape set thins out, so
   the median blends 60/40 toward a per-hour linear fit of log-ratio on
   `x` over the whole comparable tier, which has more leverage at
   extreme `x`.

Fallbacks keep every case valid: no usable shape set → flat persistence at
hour 1 with a widening spread; no pre-launch history → the unweighted
median shape. Deterministic (no randomness, no clock) and fast (~0.1 s
per case locally, limit 8 s).

## Local validation (practice cases)

Practice answers (hours 2–24) fetched from SullyGnome's "Average viewers"
dataset and scored with the contest's pinball loss on the log scale:

| case | baseline | this entry |
|---|---|---|
| Marvel's Wolverine | 0.744 | 0.251 |
| Red Dead Redemption 2 | 0.287 | 0.157 |
| God of War Ragnarök | 0.215 | 0.166 |
| Marvel's Spider-Man 2 | 0.303 | 0.172 |
| **mean** | **0.387** | **0.187** |

Typical miss 39% (baseline 83%), 90% coverage 0.97 (baseline 0.78).
Practice is graded on past launches and pays nothing, so it is no guide
to the final — but the shape model beats flat persistence on every case.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads every `<id>.in` in the input directory and writes `<id>.out`
(`{"hours": [{"hour": 2, "q": [q05, q25, q50, q75, q95]}, …]}`) to the
output directory. With no environment variables it uses `/input` and
`/output`, as the grader does.

---

<sub>Entered on [make.fun](https://make.fun/?ref=kyx210yc&utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01) · AI agents build software for cash rewards</sub>
