'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

export function backendFetch(path: string, init?: RequestInit): Promise<Response> {
  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL
  return fetch(`${backendUrl}${path}`, { ...init, credentials: 'include' })
}

// Internal sentinel used by useResource to signal "state already handled
// (or intentionally left untouched) upstream, do not process this as a
// loaded value" — distinct from a real `null` JSON response body, which is
// a legitimate value for resources that are simply not configured yet.
const SKIP = Symbol('useResource:skip')

export type UseResourceOptions<T> = {
  redirectOn401?: boolean
  pollMs?: number
  stopPolling?: (data: T) => boolean
}

export type UseResourceResult<T> = {
  data: T | null
  loading: boolean
  error: boolean
  notFound: boolean
}

export function useResource<T>(path: string, opts: UseResourceOptions<T> = {}): UseResourceResult<T> {
  const router = useRouter()
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const generationRef = useRef(0)
  const hasLoadedRef = useRef(false)

  useEffect(() => {
    hasLoadedRef.current = false

    function stopInterval() {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }

    function load() {
      const generation = ++generationRef.current

      function isCurrent() {
        return generation === generationRef.current
      }

      backendFetch(path)
        .then((res) => {
          if (!isCurrent()) return SKIP
          if (res.status === 401 && opts.redirectOn401) {
            router.replace('/')
            stopInterval()
            return SKIP
          }
          if (res.status === 404) {
            setNotFound(true)
            setLoading(false)
            stopInterval()
            return SKIP
          }
          if (res.status !== 200) {
            throw new Error(`unexpected status ${res.status}`)
          }
          return res.json()
        })
        .then((json) => {
          if (!isCurrent()) return
          // `json` may legitimately be `null` for resources that are simply
          // not configured yet (e.g. billing settings) — only the internal
          // SKIP sentinel (used above for stale-generation/401/404, which
          // already updated state or intentionally left it untouched) should
          // bail out here without recording a load.
          if (json === SKIP) return
          setData(json)
          setLoading(false)
          hasLoadedRef.current = true
          if (opts.pollMs && opts.stopPolling && opts.stopPolling(json)) {
            stopInterval()
          }
        })
        .catch(() => {
          if (!isCurrent()) return
          if (opts.pollMs && hasLoadedRef.current) {
            // Transient failure mid-poll with last-known-good data already
            // shown — let the next scheduled poll retry instead of
            // replacing good data with an error.
            return
          }
          setError(true)
          setLoading(false)
          stopInterval()
        })
    }

    load()

    if (opts.pollMs) {
      intervalRef.current = setInterval(load, opts.pollMs)
    }

    return stopInterval
  }, [path])

  return { data, loading, error, notFound }
}

export function useTosGate(me: UseResourceResult<{ tosAcceptanceRequired: boolean }>) {
  const router = useRouter()

  useEffect(() => {
    if (me.data?.tosAcceptanceRequired) {
      router.replace('/accept-terms')
    }
  }, [me.data, router])
}
