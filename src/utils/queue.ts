export class Queue<T> {
  private items: T[] = [];
  private head = 0;
  private readonly maxSize: number;

  constructor(maxSize: number = Infinity) {
    this.maxSize = maxSize;
  }

  enqueue(item: T): boolean {
    if (this.size() >= this.maxSize) {
      return false;
    }
    this.items.push(item);
    return true;
  }

  dequeue(): T | undefined {
    if (this.head >= this.items.length) {
      return undefined;
    }
    const item = this.items[this.head];
    this.head++;
    // Compact array when half empty to prevent unbounded growth
    if (this.head > 100 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return item;
  }

  peek(): T | undefined {
    return this.items[this.head];
  }

  size(): number {
    return this.items.length - this.head;
  }

  isEmpty(): boolean {
    return this.size() === 0;
  }

  clear(): void {
    this.items = [];
    this.head = 0;
  }

  /** Return a shallow copy of all queued items for inspection */
  toArray(): readonly T[] {
    return this.items.slice(this.head);
  }

  getMaxSize(): number {
    return this.maxSize;
  }
}
