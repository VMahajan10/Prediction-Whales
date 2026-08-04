/** Keep-previous-data: a revalidation that yields nothing must not blank the UI. */
export function retainLastNonEmpty<T>(next: T[], previous: T[]): T[] {
  return next.length > 0 ? next : previous;
}
