type TopBarProps = {
  location?: string
  username?: string
  isAdmin?: boolean
}

export default function TopBar({ location, username, isAdmin }: TopBarProps) {
  return (
    <header className="topbar">
      <div className="topbar-brand">
        <a href="/dashboard" style={{ color: 'inherit', textDecoration: 'none' }}>
          <span className="topbar-prompt">&gt;</span> practice
        </a>
        {location && <span className="topbar-location">{location}</span>}
        <a href="/ranking" className="topbar-nav-link">
          Ranking
        </a>
      </div>
      {username && (
        <div className="topbar-user">
          {isAdmin && (
            <>
              <span className="topbar-admin-tag">admin</span>
              <a href="/admin/llm-settings">LLM</a>
              <a href="/admin/tos">ToS</a>
              <a href="/admin/billing">Billing</a>
            </>
          )}
          <span>{username}</span>
          <a href={`${process.env.NEXT_PUBLIC_BACKEND_URL}/auth/logout`}>Logout</a>
        </div>
      )}
    </header>
  )
}
