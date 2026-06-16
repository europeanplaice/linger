interface Props {
  className?: string
  fetchPriority?: 'high' | 'low' | 'auto'
}

export function AppIcon({ className }: Props) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      aria-hidden="true"
    >
      <path
        d="M 14 14 L 14 42 C 14 46.4 17.6 50 22 50 L 48 50"
        fill="none"
        stroke="currentColor"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="48" cy="14" r="4" fill="currentColor" />
    </svg>
  )
}
