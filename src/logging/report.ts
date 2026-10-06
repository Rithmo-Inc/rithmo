// Operator-facing CLI output, deliberately separate from the logger.
//
// The two have different jobs and must not be confused. createLogger records structured
// operational events to var/ for later inspection; this prints a human-readable report to
// the terminal so an operator can review a proposed change before approving it.
//
// Keeping them apart means a script cannot accidentally satisfy its logging obligation by
// printing, or its reporting obligation by logging into a file nobody is watching.
//
// This module writes text and nothing else: no levels, no timestamps, no fields, no
// redaction policy. Anything that needs those belongs in the logger.

export interface Reporter {
  line(text?: string): void;
  /** A removed/old value, rendered so a diff reads at a glance. */
  removed(text: string): void;
  /** An added/new value. */
  added(text: string): void;
  problem(text: string): void;
}

export function createReporter(
  out: (s: string) => void = (s) => process.stdout.write(s),
  err: (s: string) => void = (s) => process.stderr.write(s),
): Reporter {
  return {
    line: (text = "") => out(`${text}\n`),
    removed: (text) => out(`  -  ${text}\n`),
    added: (text) => out(`  +  ${text}\n`),
    problem: (text) => err(`${text}\n`),
  };
}
