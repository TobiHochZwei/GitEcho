import cronstrue from 'cronstrue';

/**
 * Convert a cron expression to a human-readable sentence.
 * Returns a fallback string when parsing fails (e.g. invalid expression).
 */
export function humanizeCron(expression: string | undefined | null, locale: string = 'en'): string {
  if (!expression || !expression.trim()) return 'No schedule set';
  try {
    return cronstrue.toString(expression, { locale, use24HourTimeFormat: true, verbose: false });
  } catch {
    return 'Invalid cron expression';
  }
}
