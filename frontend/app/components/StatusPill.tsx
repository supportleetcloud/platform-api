type StatusPillProps = {
  status: string
}

function variantFor(status: string): string {
  if (status === 'passed') return 'pill-pass'
  if (status === 'failed') return 'pill-fail'
  return 'pill-neutral'
}

export default function StatusPill({ status }: StatusPillProps) {
  return <span className={`pill ${variantFor(status)}`}>{status}</span>
}
