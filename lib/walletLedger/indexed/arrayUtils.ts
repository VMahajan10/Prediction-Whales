/** V8 caps spread-call arity (~65k args); chunk appends stay stack-safe. */
const DEFAULT_APPEND_CHUNK = 8_192;

export function appendAll<T>(
  target: T[],
  source: readonly T[],
  chunkSize = DEFAULT_APPEND_CHUNK
): void {
  for (let i = 0; i < source.length; i += chunkSize) {
    target.push(...source.slice(i, i + chunkSize));
  }
}

export function minOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let min = values[0]!;
  for (let i = 1; i < values.length; i++) {
    const value = values[i]!;
    if (value < min) min = value;
  }
  return min;
}

export function maxOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let max = values[0]!;
  for (let i = 1; i < values.length; i++) {
    const value = values[i]!;
    if (value > max) max = value;
  }
  return max;
}
