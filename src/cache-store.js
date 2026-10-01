export class MemoryCacheStore {
  constructor() {
    this.entry = undefined
  }

  async get() {
    return this.entry
  }

  async set(entry) {
    this.entry = entry
  }

  async acquireRefreshLock() {
    return true
  }

  async releaseRefreshLock() {}

  async close() {}
}

export class RedisCacheStore {
  constructor({ client, prefix }) {
    this.client = client
    this.entryKey = `${prefix}:configuration`
    this.lockKey = `${prefix}:refresh-lock`
  }

  static async connect({ url, prefix, logger = console }) {
    const { createClient } = await import('redis')
    const client = createClient({ url })
    client.on('error', (error) => logger.error?.('Redis cache error', error))
    await client.connect()
    return new RedisCacheStore({ client, prefix })
  }

  async get() {
    const value = await this.client.get(this.entryKey)
    if (!value) return undefined

    try {
      return JSON.parse(value)
    } catch {
      await this.client.del(this.entryKey)
      return undefined
    }
  }

  async set(entry) {
    await this.client.set(this.entryKey, JSON.stringify(entry))
  }

  async acquireRefreshLock(token, ttlMs) {
    const result = await this.client.set(this.lockKey, token, {
      NX: true,
      PX: ttlMs,
    })
    return result === 'OK'
  }

  async releaseRefreshLock(token) {
    await this.client.eval(
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
      {
        arguments: [token],
        keys: [this.lockKey],
      }
    )
  }

  async close() {
    if (this.client.isOpen) await this.client.quit()
  }
}
