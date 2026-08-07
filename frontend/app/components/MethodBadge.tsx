type MethodBadgeProps = {
  method: string
}

const VARIANTS: Record<string, string> = {
  GET: 'badge-method-get',
  POST: 'badge-method-post',
  PUT: 'badge-method-put',
  PATCH: 'badge-method-patch',
  DELETE: 'badge-method-delete',
}

export default function MethodBadge({ method }: MethodBadgeProps) {
  return <span className={`badge-method ${VARIANTS[method] ?? ''}`}>{method}</span>
}
