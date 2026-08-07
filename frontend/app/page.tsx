export default function HomePage() {
  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL

  return (
    <main className="landing">
      <div className="landing-wordmark">
        <span className="topbar-prompt">&gt;</span> practice
      </div>
      <p className="landing-tagline">
        Submit your API&apos;s URL. Watch the checks run. Fix what fails.
      </p>
      <a className="btn btn-primary" href={`${backendUrl}/auth/github`}>
        Login with GitHub
      </a>
    </main>
  )
}
