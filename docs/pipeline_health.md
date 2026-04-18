# Pipeline health

This document summarizes the current status of the main pipelines and their tests
on this branch, based on the latest `pytest` runs and coverage for `lib/target`.

## Current test status

From `pytest --maxfail=1 --disable-warnings -q` (this branch):

- 10 tests **pass**.
- 1 test **fails**:
  - `tests/test_sec_actions_and_edgar.py::test_import_sec_bulk_reference_with_minimal_payloads`
    - Failure is an `sqlite3.OperationalError` when creating the
      `instrument_sec_mapping` table via `pandas.DataFrame.to_sql`, because the
      DataFrame is empty and leads to a `CREATE TABLE instrument_sec_mapping ()`
      statement. This reflects a gap in robustness/error‑handling when
      `import_sec_bulk_reference` is invoked with an empty mapping DataFrame.

Other pipelines exercised by the existing tests currently pass.

## Coverage snapshot for lib/target

From `pytest --cov=lib.target --cov-report=term-missing` (this branch):

- `lib/target/sec_actions.py`: partially covered via
  `tests/test_sec_actions_and_edgar.py`. The new
  `import_sec_bulk_reference` path is exercised but currently fails when the
  SEC tick‑mapping DataFrame is empty.
- Other core orchestration modules (`eod_actions`, `eod_client`, `experiments`,
  `paths`, `sec_edgar`) remain effectively uncovered here; their behavior is not
  directly exercised by tests on this branch.

For a more detailed breakdown of remaining coverage gaps and high‑value next
tests, see `docs/testing_gaps.md`.

## High‑level pipeline view

- **EOD market‑data pipelines**
  - Implementation lives in `lib/target/eod_actions.py`, `eod_client.py`, and
    related helpers.
  - **Test status:** no direct tests on this branch; pipeline health is
    unknown beyond basic importability.

- **Experiment orchestration**
  - Implementation in `lib/target/experiments.py`.
  - **Test status:** no direct tests on this branch; experiment end‑to‑end
    behavior is untested here.

- **SEC ingestion and mapping**
  - Implementation in `lib/target/sec_actions.py` and `sec_edgar.py`.
  - **Test status:** partially tested by
    `tests/test_sec_actions_and_edgar.py`.
    - Basic download helper for SEC bulk reference passes with a dummy client.
    - Import path for SEC bulk reference currently fails when the
      instrument‑SEC mapping is empty, due to the `to_sql`/`CREATE TABLE ()`
      issue noted above.
    - Behavior for non‑empty mappings is not yet covered.

## Next high‑value robustness checks

Across pipelines, the highest‑value next steps (aligned with
`docs/testing_gaps.md`) are:

1. **Harden SEC bulk import against empty/degenerate inputs**
   - In `import_sec_bulk_reference`, treat an empty or schema‑less mapping
     DataFrame as a first‑class case: either skip table creation with a clear
     log message or create a well‑defined empty table with explicit columns.
   - Add/extend tests so both the empty‑mapping and minimal‑non‑empty cases
     pass without raising.

2. **Add minimal end‑to‑end EOD bulk history test**
   - Exercise the smallest slice of the EOD pipeline that downloads,
     normalizes, and writes history for a few symbols, using in‑memory or
     temporary‑filesystem mocks (no real network/DB).
   - Verify that expected files/manifests are created and that empty client
     responses are handled gracefully.

3. **Add a basic experiment orchestration smoke test**
   - Drive the main experiment entry point with a tiny synthetic dataset and
     simple model, asserting that the run completes and produces expected
     output artifacts/metrics.
