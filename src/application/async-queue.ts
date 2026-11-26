/** A push-based async iterable with one consumer: the glue between callbacks and `for await`. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    this.items.push(item);
    this.wakeUp();
  }

  close(): void {
    this.closed = true;
    this.wakeUp();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const item = this.items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => { this.waiter = resolve; });
    }
  }

  private wakeUp(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }
}
