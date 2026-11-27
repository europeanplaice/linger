// An installed PWA normally handles this navigation entirely in its service
// worker. Never read, reflect, or store the share if that worker is unavailable.
export const onRequestPost: PagesFunction = async () => new Response(
  'Open Linger to update it, then share again. Linger を開いて更新してから、もう一度共有してください。',
  { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } },
)
