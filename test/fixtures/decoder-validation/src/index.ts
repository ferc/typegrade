/**
 * Decoder-validation fixture: mimics the "decoders" library.
 * Has Ok/Err type aliases (which could confuse detection into "result"),
 * but the primary purpose is validation/decoding.
 */

/** Successful decode outcome */
export type Ok<T> = { readonly ok: true; readonly value: T };

/** Failed decode outcome */
export type Err = { readonly ok: false; readonly error: Error };

/** Result of a decode operation */
export type Result<T> = Ok<T> | Err;

/** A decoder transforms unknown input into a typed value */
export interface Decoder<T> {
  decode(input: unknown): Result<T>;
  verify(input: unknown): T;
  guard(input: unknown): input is T;
}

/** Decode an unknown value using a decoder */
export function decode<T>(decoder: Decoder<T>, input: unknown): Result<T> {
  return decoder.decode(input);
}

/** Verify an unknown value, throwing on failure */
export function verify<T>(decoder: Decoder<T>, input: unknown): T {
  return decoder.verify(input);
}

/** Guard an unknown value with a type predicate */
export function guard<T>(decoder: Decoder<T>, input: unknown): input is T {
  return decoder.guard(input);
}

/** Create a decoder from a guard function */
export function fromGuard<T>(guardFn: (val: unknown) => val is T): Decoder<T> {
  return {
    decode: (input: unknown): Result<T> => {
      if (guardFn(input)) {
        return { ok: true, value: input };
      }
      return { ok: false, error: new Error("Decode failed") };
    },
    guard: guardFn,
    verify: (input: unknown): T => {
      if (guardFn(input)) {
        return input;
      }
      throw new Error("Verify failed");
    },
  };
}

/** String decoder */
export function string(): Decoder<string> {
  return fromGuard((val: unknown): val is string => typeof val === "string");
}

/** Number decoder */
export function number(): Decoder<number> {
  return fromGuard((val: unknown): val is number => typeof val === "number");
}

/** Boolean decoder */
export function boolean(): Decoder<boolean> {
  return fromGuard((val: unknown): val is boolean => typeof val === "boolean");
}

/** Compose decoders for an object shape */
export function object<T extends Record<string, Decoder<unknown>>>(
  shape: T,
): Decoder<{ [K in keyof T]: T[K] extends Decoder<infer U> ? U : never }> {
  return {
    decode: (input: unknown) => {
      if (typeof input !== "object" || input === null) {
        return { ok: false, error: new Error("Expected object") };
      }
      const result = {} as Record<string, unknown>;
      for (const [key, decoder] of Object.entries(shape)) {
        const fieldResult = decoder.decode((input as Record<string, unknown>)[key]);
        if (!fieldResult.ok) {
          return fieldResult;
        }
        result[key] = fieldResult.value;
      }
      return { ok: true, value: result } as Ok<{
        [K in keyof T]: T[K] extends Decoder<infer U> ? U : never;
      }>;
    },
    guard: (
      input: unknown,
    ): input is {
      [K in keyof T]: T[K] extends Decoder<infer U> ? U : never;
    } => typeof input === "object" && input !== null,
    verify: (input: unknown) => {
      const decoded = object(shape).decode(input);
      if (!decoded.ok) {
        throw decoded.error;
      }
      return decoded.value;
    },
  };
}
