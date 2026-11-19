import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import type { OrgRole, OrganizationRow, ProfileRow } from '../lib/database.types'

export interface Membership {
  role: OrgRole
  organization: OrganizationRow
}

type Status = 'loading' | 'ready'

export interface AuthValue {
  status: Status
  configured: boolean
  session: Session | null
  user: User | null
  profile: ProfileRow | null
  memberships: Membership[]
  currentOrg: OrganizationRow | null
  currentRole: OrgRole | null
  isSuperAdmin: boolean
  isOrgAdmin: boolean
  /** Errore nel caricamento di profilo/membership (non di autenticazione). */
  contextError: string | null
  setCurrentOrgId: (id: string) => void
  refresh: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthValue | null>(null)
const ORG_KEY = 'lf-current-org'

function savedOrgId(): string | null {
  try {
    return localStorage.getItem(ORG_KEY)
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>(supabase ? 'loading' : 'ready')
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<ProfileRow | null>(null)
  const [memberships, setMemberships] = useState<Membership[]>([])
  const [currentOrgId, setCurrentOrgIdState] = useState<string | null>(savedOrgId)
  const [contextError, setContextError] = useState<string | null>(null)
  const [loadedFor, setLoadedFor] = useState<string | null>(null)

  const loadContext = useCallback(async (s: Session | null) => {
    if (!supabase || !s) {
      setProfile(null)
      setMemberships([])
      setLoadedFor(null)
      return
    }
    setContextError(null)
    const [profileRes, membersRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', s.user.id).maybeSingle(),
      supabase
        .from('organization_members')
        .select('role, organization:organizations(*)')
        .eq('user_id', s.user.id)
        .order('created_at', { ascending: true }),
    ])
    if (profileRes.error || membersRes.error) {
      setContextError('errors.generic')
      setLoadedFor(s.user.id)
      return
    }
    setProfile(profileRes.data)
    const rows = (membersRes.data ?? []) as unknown as { role: OrgRole; organization: OrganizationRow | null }[]
    // Le organizzazioni disattivate non sono visibili via RLS: vengono escluse.
    setMemberships(rows.filter((r): r is Membership => !!r.organization && !r.organization.deleted_at))
    setLoadedFor(s.user.id)
  }, [])

  useEffect(() => {
    if (!supabase) return
    let active = true
    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return
      setSession(data.session)
      await loadContext(data.session)
      if (active) setStatus('ready')
    })
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s)
      // Evita chiamate al DB dentro il callback sincrono (raccomandazione Supabase).
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
        setTimeout(() => {
          void loadContext(s)
        }, 0)
      }
    })
    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [loadContext])

  const setCurrentOrgId = useCallback((id: string) => {
    setCurrentOrgIdState(id)
    try {
      localStorage.setItem(ORG_KEY, id)
    } catch {
      /* ignore */
    }
  }, [])

  const refresh = useCallback(async () => {
    if (!supabase) return
    const { data } = await supabase.auth.getSession()
    setSession(data.session)
    await loadContext(data.session)
  }, [loadContext])

  const signOut = useCallback(async () => {
    if (!supabase) return
    await supabase.auth.signOut()
    try {
      localStorage.removeItem(ORG_KEY)
    } catch {
      /* ignore */
    }
    setCurrentOrgIdState(null)
    setSession(null)
    setProfile(null)
    setMemberships([])
  }, [])

  const value = useMemo<AuthValue>(() => {
    const current = memberships.find((m) => m.organization.id === currentOrgId) ?? memberships[0] ?? null
    // Sessione presente ma profilo/membership non ancora caricati → ancora in loading.
    const contextPending = !!session && loadedFor !== session.user.id
    return {
      status: status === 'ready' && !contextPending ? 'ready' : 'loading',
      configured: !!supabase,
      session,
      user: session?.user ?? null,
      profile,
      memberships,
      currentOrg: current?.organization ?? null,
      currentRole: current?.role ?? null,
      isSuperAdmin: profile?.platform_role === 'super_admin',
      isOrgAdmin: current?.role === 'organization_admin',
      contextError,
      setCurrentOrgId,
      refresh,
      signOut,
    }
  }, [status, session, profile, memberships, currentOrgId, contextError, loadedFor, setCurrentOrgId, refresh, signOut])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

/** Esposto per i test dei guard. */
export { AuthContext }
