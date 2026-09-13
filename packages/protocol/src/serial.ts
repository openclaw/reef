export function createSerialQueue(): <T>(operation: () => T | Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return (operation) => {
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}
