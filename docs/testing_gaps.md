# Testing gaps

This file summarizes the highest-value remaining testing gaps, based on the
latest coverage and test runs on this branch.

## Current coverage snapshot (lib/target)

From `pytest --cov=lib.target --cov-report=term-missing` (this branch):

- `lib/target/sec_actions.py`: **partially covered** via
  `tests/test_sec_actions_and_edgar.py`. The new
  `import_sec_bulk_reference` path is exercised but currently fails when the
  SEC tick‑mapping DataFrame is empty, due to an `sqlite3.OperationalError`
  arising from `pandas.DataFrame.to_sql` attempting to create an empty table
  (`CREATE TABLE instrument_sec_mapping ()`).
- `lib/target/__init__.py`: 0%
- `lib/target/eod_actions.py`: 0%
- `lib/target/eod_client.py`: 0%
- `lib/target/experiments.py`: 0%
- `lib/target/paths.py`: 0%
- `lib/target/sec_edgar.py`: 0%

Even though we have several high-value tests on other branches, on this branch
most of the main orchestration modules in `lib/target` are still effectively
untested.

## Top testing gaps and next-test suggestions

Below are the 3 highest‑value next tests/robustness checks to add. They are
scoped so each can be implemented as a focused unit/integration test.

1. **Harden SEC bulk import against empty/degenerate inputs**

   Target: `lib/target/sec_actions.import_sec_bulk_reference`

   **Motivation:** The existing
   `tests/test_sec_actions_and_edgar.py::test_import_sec_bulk_reference_with_minimal_payloads`
   currently fails when the instrument‑SEC mapping DataFrame is empty, because
   `to_sql` ends up issuing `CREATE TABLE instrument_sec_mapping ()`. We want
   this empty/degenerate case to be explicitly handled.

   **Next robustness checks:**

   - Update `import_sec_bulk_reference` so that:
     - If the mapping DataFrame is empty or has no columns, it either:
       - Skips table creation with a clear log message, or
       - Creates a well‑defined empty table with explicit columns and types.
   - Extend the existing test to assert that:
     - The function completes without raising for the empty‑mapping case.
     - The function also behaves correctly for a minimal non‑empty mapping,
       e.g., one synthetic ticker/CIK row.

2. **EOD bulk history normalization and import: `lib/target/eod_actions.py`**

   This module contains core orchestration logic for downloading, normalizing,
   and importing EOD market history, but it is completely uncovered here.

   **Next test to add (high value, medium effort):**

   - A test that exercises the smallest end‑to‑end slice of the bulk history
     flow that does *not* hit the real network or database. Strategy:
       - Use a temporary directory as the EOD root/universe root.
       - Monkeypatch or fixture‑inject:
         - Any EOD client object so that calls return small in‑memory
           DataFrames for a tiny set of symbols.
         - Any filesystem helpers so the code writes into the temp directory.
       - Drive the public entry point that orchestrates "download bulk
         history" for 1–2 symbols over a tiny date range.
       - Assert that:
         - Expected CSVs or parquet files are materialized in the temp tree.
         - Any manifest/metadata files contain the right symbols, row counts,
           and date ranges.
         - The code behaves sensibly when the client returns an empty
           DataFrame (e.g., still creates an empty batch/manifest entry).

3. **Experiment orchestration: `lib/target/experiments.py`**

   This module coordinates loading data, building models, running experiments,
   and writing outputs. It is central to the project’s value but currently
   entirely untested on this branch.

   **Next test to add (high value, small–medium effort):**

   - A unit/integration test that drives the main "run basic experiment" entry
     point with a minimal synthetic configuration. Concretely:
       - Construct a small in‑memory or temporary on‑disk dataset matching the
         expected schema (a few symbols × a few dates with toy prices/labels).
       - Use a very simple model (e.g., a linear model or dummy model already
         wired into the registry) so the run is fast and deterministic.
       - Run the experiment orchestration function.
       - Assert that:
         - The run completes without raising.
         - Expected outputs (artifacts, metrics files, or result tables) are
           created in a temporary output directory.
         - Basic sanity checks on metrics hold (e.g., metric keys exist and
           numeric values are finite).

These three items will immediately improve both robustness and coverage for the
most critical modules and provide stronger regression protection for future
refactors.
