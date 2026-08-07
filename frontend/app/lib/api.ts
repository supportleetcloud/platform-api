'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

export function backendFetch(path: string, init?: RequestInit): Promise<Response> {
  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL
  return fetch(`${backendUrl}${path}`, { ...init, credentials: 'include' })
}

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

  useEffect(() => {
    function stopInterval() {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }

    function load() {
      backendFetch(path)
        .then((res) => {
          if (res.status === 401 && opts.redirectOn401) {
            router.replace('/')
            stopInterval()
            return null
          }
          if (res.status === 404) {
            setNotFound(true)
            setLoading(false)
            stopInterval()
            return null
          }
          if (res.status !== 200) {
            throw new Error(`unexpected status ${res.status}`)
          }
          return res.json()
        })
        .then((json) => {
          if (json === null || json === undefined) return
          setData(json)
          setLoading(false)
          if (opts.pollMs && opts.stopPolling && opts.stopPolling(json)) {
            stopInterval()
          }
        })
        .catch(() => {
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
