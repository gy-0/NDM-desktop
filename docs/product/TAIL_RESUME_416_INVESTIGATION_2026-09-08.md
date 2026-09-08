# Tail-split 416 after reopening: verified compatibility gap

**Repair status:** the historical failure below is now covered by the [persisted provenance repair](TAIL_PROVENANCE_RECOVERY_2026-09-08.md). The test now requires successful recovery; the following records the pre-repair baseline.

This is an investigation of current behavior, not a completed engine repair or proof of Neat equivalence. The product still safely fails this scenario without publishing a mixed or incomplete file.

`automaticTailOrigins` in DownloadEngine is per-run memory. A speculative tail child can return 416 and roll back during the same run. If its plan is persisted, the task paused and a new engine instance opened, the child's origin is no longer known; the same refusal is treated as an ordinary initial Range failure.

`TailResume416InvestigationTests` exercises four local scenarios: v2 and legacy, each continuously and after pause/reopen. Continuous runs record four Range requests and complete via rollback with byte-for-byte matching output. Reopened runs record five Range requests and fail closed with 416 and no final file. The fixture intentionally rejects the speculative child, a nonstandard Range-server compatibility scenario; ordinary valid servers are not claimed to exhibit this failure.

Run: `swift test --package-path native --filter TailResume416InvestigationTests`. Evidence: `/tmp/ndm-tail-resume-416-investigation.log`. The test characterizes a known limitation; it must be updated when recovery is improved, rather than used to freeze this behavior as a requirement. No production engine changes accompany this investigation.

A repair needs durable provenance and an ownership-safe rollback after reopening, in both storage formats. It must retain fatal handling for a genuinely invalid initial 416 and must not make already written child bytes eligible for unsafe joining. Existing successful resume tests do not prove this combined failure case.
