/** Result type: either success with value or failure with error */
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

/** Option type: either some value or none */
export type Option<T> = { some: true; value: T } | { some: false };

/** Create a successful result */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Create a failed result */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Create a some option */
export function some<T>(value: T): Option<T> {
  return { some: true, value };
}

/** Create a none option */
export function none(): Option<never> {
  return { some: false };
}

/** Map over a result's success value */
export function mapResult<T, U, E>(result: Result<T, E>, fn: (val: T) => U): Result<U, E> {
  if (result.ok) {
    return { ok: true, value: fn(result.value) };
  }
  return result;
}

/** Map over an option's value */
export function mapOption<T, U>(option: Option<T>, fn: (val: T) => U): Option<U> {
  if (option.some) {
    return { some: true, value: fn(option.value) };
  }
  return option;
}

/** Unwrap a result or throw */
export function unwrap<T>(result: Result<T, unknown>): T {
  if (result.ok) {
    return result.value;
  }
  throw result.error;
}

/** Unwrap an option or return a default */
export function unwrapOr<T>(option: Option<T>, fallback: T): T {
  if (option.some) {
    return option.value;
  }
  return fallback;
}

/** Chain results together */
export function flatMap<T, U, E>(result: Result<T, E>, fn: (val: T) => Result<U, E>): Result<U, E> {
  if (result.ok) {
    return fn(result.value);
  }
  return result;
}

/** Check if a result is ok */
export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok;
}

/** Check if an option has a value */
export function isSome<T>(option: Option<T>): option is { some: true; value: T } {
  return option.some;
}

/** Convert nullable value to option */
export function fromNullable<T>(value: T | null | undefined): Option<T> {
  if (value === null || value === undefined) {
    return { some: false };
  }
  return { some: true, value };
}

/** Collect an array of results into a result of array */
export function collect<T, E>(results: Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const rr of results) {
    if (!rr.ok) {
      return rr;
    }
    values.push(rr.value);
  }
  return { ok: true, value: values };
}

/** Apply a function to the error side of a result */
export function mapError<T, E, F>(result: Result<T, E>, fn: (er: E) => F): Result<T, F> {
  if (!result.ok) {
    return { ok: false, error: fn(result.error) };
  }
  return result;
}
