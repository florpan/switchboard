// Who is who across channels: config/users.json maps channel identities to people.
//   { "users": [ { "name": "Alex", "aliases": { "discord": ["1234..."], "email": ["alex@example.com"] },
//                  "contact": { "email": "alex@example.com" } } ] }
import { existsSync, readFileSync, watch } from 'node:fs'
import { log } from './log'

export interface User {
  name: string
  aliases: Record<string, string[]>
  contact?: { email?: string }
  [extra: string]: unknown
}

export class Users {
  private users: User[] = []

  constructor(private path: string) {
    this.load()
    if (existsSync(path)) watch(path, () => this.load())
  }

  private load() {
    try {
      const parsed = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : []
      this.users = Array.isArray(parsed) ? parsed : parsed.users ?? []
    } catch (err) {
      log('users', 'users.json not loaded:', err)
    }
  }

  /** Person for a channel identity (discord user id, email address, ...), or undefined. */
  resolve(channel: string, id: string): User | undefined {
    const key = id.toLowerCase()
    return this.users.find(u => u.aliases?.[channel]?.some(a => a.toLowerCase() === key))
  }

  byName(name: string): User | undefined {
    return this.users.find(u => u.name.toLowerCase() === name.toLowerCase())
  }

  all() {
    return [...this.users]
  }
}
