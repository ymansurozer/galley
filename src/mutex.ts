// A minimal in-process serialization queue: a promise-chain mutex. `serialize(fn)` runs `fn`
// only after every previously enqueued task has settled, so tasks execute one at a time in
// enqueue order. Enqueue order (not completion order) is what determines the run order, so the
// caller must enqueue synchronously to get a guaranteed sequence.
//
// A rejected task settles the chain WITHOUT poisoning it: the internal chain swallows the error
// (`.then(undefined-ish, undefined-ish)`), so the next task still runs, while the promise handed
// back to the caller still rejects — the caller sees its own failure.
export type Serializer = <T>(fn: () => Promise<T>) => Promise<T>;

export function createSerializer(): Serializer {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}
