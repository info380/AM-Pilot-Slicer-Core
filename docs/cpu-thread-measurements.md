# Native CPU and thread scaling measurements

This diagnostic does not build or deploy a worker. It measures the immutable
`bambu-v0.3.5` image named in `qualification/cpu-scaling/plan.json`, with its
existing engine adapters and native binaries. The manual workflow independently
verifies the image's release-workflow signature and source revision label.
Production credentials, customer geometry, cloud configuration changes, printer
commands and publication are outside the benchmark.

## Design

The full plan runs 144 sequential trials: three balanced-order repeats of eight
CPU-quota/thread-budget pairs, for both engines and three generated workloads:

- Ten linked 16,384-facet tori with identical local density modifiers.
- Ten distinct 16,384-facet tori with those same modifiers.
- One 131,072-facet torus, with the same local modifier.

The source and prepared plate are generated once per engine/workload, outside
the timed trials, then mounted read-only for every candidate. Source preparation,
queueing, downloads, preview compilation and publication are not native slicing
measurements. Each engine's explicit synthetic recipe remains fixed across its
cases. The Bambu recipe uses the pinned manufacturer's A1 0.4 mm / 0.20 mm
Standard / Generic PLA presets, textured PEI and disabled supports. The separate
Prusa recipe is retained in `fixture.mjs`; this is not a comparison of print
quality or equivalent recipe calibration between engines.

Cases cover 0.5, 1, 2 and 4 CPU quotas with budgets of 1, 2 and 4. The quota-one
cases with larger budgets measure oversubscription. A two-CPU/one-thread case
separates extra quota from parallel work. Prusa receives `--threads`; Bambu uses
the existing explicit CPU-affinity policy, not a native thread-count argument.
Observed native thread counts and CPU masks are sampled every 25 ms and reported
separately. Helper threads mean the budget is not a claim about total OS threads.

One disposable container per trial keeps cgroup resource evidence independent.
All cases use a 2 GiB memory limit, no swap, a 512 MiB temporary filesystem, four
permitted logical CPUs, no network, a read-only root, no capabilities, non-root
execution and the existing 256-process guard. Only CPU quota and execution thread
budget change. The host must be native Linux x64 with at least four available
CPUs and cgroup v2. Emulated measurements are rejected by the controller.

Native subprocess, adapter preparation and validation time are separate. Reports
retain CPU usage/throttling counters, peak cgroup memory, OOM events, actual CPU
masks, observed native threads, source/plate/recipe hashes, native settings,
G-code hashes/command hashes and native estimates. Prusa's execution-only
`threads` field is recorded separately and excluded from the physical-settings
comparison. No physical setting is otherwise ignored. Command hashes remove only
comments and surrounding whitespace; changed executable commands still differ.
Output differences and repeat variability are evidence, not proof of equal print
quality or permission to change production limits.

## Run and budget

```sh
node qualification/cpu-scaling/run.mjs validate full
node qualification/cpu-scaling/run.mjs run full /absolute/new/evidence-directory
```

The GitHub **Native CPU and thread measurements (manual)** workflow accepts only
manual dispatch on reviewed main. `full` is the complete plan; `smoke` executes
four trials on the linked workload. There is one job, no matrix, no schedule,
no push/PR execution and a 20-minute job limit. No native image is rebuilt.
[GitHub documents](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
standard public-repository Linux runners as four-CPU x64 and free for public
repositories; [artifact storage is separate](https://docs.github.com/en/billing/concepts/product-billing/github-actions). Only the small JSON
report and signature verification are uploaded, with seven-day retention. Raw
model, archive and G-code outputs remain temporary runner data.

Inspect output consistency and within-case variation before interpreting median
speedups. Public-runner relative scaling is not a production latency guarantee:
CPU model, shared-host contention, geometry, model instancing and memory limits
matter. Representative native production A/B measurements are required before
changing paid capacity or the live thread budget. No API, Admin or worker
deployment is needed for this diagnostic.
