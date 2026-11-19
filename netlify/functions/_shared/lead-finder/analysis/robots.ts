/** Parser minimale di robots.txt (RFC 9309): gruppi per user-agent, Allow/Disallow con prefisso più lungo. */
export function isAllowedByRobots(robotsTxt: string, path: string, userAgent: string): boolean {
  const ua = userAgent.toLowerCase()
  type Group = { agents: string[]; rules: { allow: boolean; path: string }[] }
  const groups: Group[] = []
  let current: Group | null = null
  let lastWasAgent = false
  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] }
        groups.push(current)
      }
      current.agents.push(value.toLowerCase())
      lastWasAgent = true
    } else if ((key === 'allow' || key === 'disallow') && current) {
      lastWasAgent = false
      if (key === 'disallow' && value === '') continue
      current.rules.push({ allow: key === 'allow', path: value })
    } else {
      lastWasAgent = false
    }
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && ua.includes(a)))
  const applicable = specific.length ? specific : groups.filter((g) => g.agents.includes('*'))
  const rules = applicable.flatMap((g) => g.rules)
  let best: { allow: boolean; len: number } | null = null
  for (const r of rules) {
    const pattern = r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')
    const re = new RegExp(`^${pattern}`)
    if (re.test(path) && (!best || r.path.length > best.len || (r.path.length === best.len && r.allow))) {
      best = { allow: r.allow, len: r.path.length }
    }
  }
  return best ? best.allow : true
}
