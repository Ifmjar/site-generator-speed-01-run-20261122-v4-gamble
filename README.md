# site-generator-speed-01-run-20261122-v4-gamble

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Ifmjar/site-generator-speed-01-run-20261122-v4-gamble/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Ifmjar/site-generator-speed-01-run-20261122-v4-gamble/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

The proven v1 solve.js (compiled templates, memoised fragment rendering, fused single-pass Markdown renderer — byte-identical static-site builds) with one change only: the driver stringifies each case's answer separately instead of one big `JSON.stringify` over the whole answer array. On the practice set that driver change alone measured about 6% faster in local A/B (median child CPU 706 ms vs 752 ms over 8 alternating rounds, answers verified identical).

## Run it

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=20hyksg9&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
