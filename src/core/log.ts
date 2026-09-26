export function log(scope: string, ...args: unknown[]) {
  const time = new Date().toLocaleTimeString('sv-SE')
  console.log(`${time} [${scope}]`, ...args.map(a => (a instanceof Error ? a.message : a)))
}
