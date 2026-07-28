/**
 * Prints full diagnostic detail for a fatal script failure.
 *
 * `err.message` alone is not enough: an AggregateError (which Node
 * throws for a failed network connection when a hostname resolves to
 * more than one address -- exactly what happens connecting to most
 * managed Postgres providers) has an empty top-level `.message` by
 * default. The real reasons live in `.errors`, so a plain
 * `err instanceof Error ? err.message : err` prints nothing useful and
 * a CI log shows a bare "Process completed with exit code 1" with no
 * clue why.
 */
export function reportError(err: unknown): void {
  console.error(err);
  if (err instanceof AggregateError) {
    for (const [i, cause] of err.errors.entries()) {
      console.error(`  cause ${i + 1}:`, cause);
    }
  }
}
