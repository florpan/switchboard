// Connected speakers (ESP32 "Jarvis" boards) and their friendly names from config/voice-devices.json:
//   { "devices": { "jarvis-aabbcc": "kitchen" } }
import { existsSync, readFileSync } from 'node:fs'
import type { ServerWebSocket } from 'bun'
import { RealtimeSTT } from './stt'

export interface Device {
  id: string // from the hello frame, e.g. jarvis-aabbcc
  name: string // friendly name, or the id
  ws: ServerWebSocket<any>
  connectedAt: string
  /** Audio of the utterance in progress. */
  stt?: RealtimeSTT
  audio: Uint8Array[]
  /** Serializes speech so two answers never interleave on one speaker. */
  speaking: Promise<void>
  /** Set while a transcript waits for Claude's first speak() on this device. */
  waiting?: Timer
}

export class Devices {
  private byId = new Map<string, Device>()

  constructor(private namesFile: string) {}

  add(ws: ServerWebSocket<any>, id: string): Device {
    const names: Record<string, string> = existsSync(this.namesFile) ? JSON.parse(readFileSync(this.namesFile, 'utf8')).devices ?? {} : {}
    const device: Device = { id, name: names[id] ?? id, ws, connectedAt: new Date().toISOString(), audio: [], speaking: Promise.resolve() }
    this.byId.set(id, device)
    return device
  }

  remove(device: Device) {
    if (this.byId.get(device.id) === device) this.byId.delete(device.id)
  }

  /** By friendly name or id; no target = every device. */
  find(target?: string): Device[] {
    const all = [...this.byId.values()]
    return target ? all.filter(d => d.name === target || d.id === target) : all
  }

  list() {
    return [...this.byId.values()].map(({ id, name, connectedAt }) => ({ id, name, connectedAt }))
  }
}
