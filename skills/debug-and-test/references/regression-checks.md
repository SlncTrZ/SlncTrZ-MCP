# Choosing regression evidence

- Prefer a check that fails under the original implementation and passes after the fix.
- Assert the externally relevant behavior, including the failure or cancellation path that caused
  the defect. Avoid assertions that merely reproduce the new implementation.
- For retries and rejected requests, verify side-effect counts as well as returned errors.
- For filesystem or process behavior, exercise the real boundary in a disposable directory.
- Use a focused check first. Broaden coverage when shared code changed or the release gate requires it.
- Report skipped checks and platform limitations separately from passing checks.
