export class TtlCache<T> {
  private readonly entries = new Map<string, { expiresAt: number, value: T }>()

  get(key: string) {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: string, value: T, ttlMs: number) {
    this.entries.set(key, { expiresAt: Date.now() + ttlMs, value })
  }

  clear() {
    this.entries.clear()
  }
}
