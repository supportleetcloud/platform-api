export default function HomePage() {
  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL

  return (
    <main>
      <h1>Practice Platform</h1>
      <a href={`${backendUrl}/auth/github`}>Login with GitHub</a>
    </main>
  )
}
