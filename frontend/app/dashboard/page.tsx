'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

type Me = {
  id: string
  username: string
  avatarUrl: string | null
  isAdmin: boolean
}

export default function DashboardPage() {
  const router = useRouter()
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL

    fetch(`${backendUrl}/api/me`, { credentials: 'include' })
      .then((res) => {
        if (res.status === 401) {
          router.replace('/')
          return null
        }
        return res.json()
      })
      .then((data) => {
        if (data) setMe(data)
        setLoading(false)
      })
  }, [router])

  if (loading) return <p>Loading...</p>
  if (!me) return null

  return (
    <main>
      <h1>Welcome, {me.username}</h1>
      {me.isAdmin && <p>Admin access enabled</p>}
      <a href={`${process.env.NEXT_PUBLIC_BACKEND_URL}/auth/logout`}>Logout</a>
    </main>
  )
}
