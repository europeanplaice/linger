import type { BrowserContext, Page } from '@playwright/test'

const origin = 'https://www.googleapis.com'

export function mockUploadUrl(operationId: string): string {
  return `${origin}/upload/drive/v3/files?upload_id=${encodeURIComponent(operationId)}`
}

export async function mockGoogleDrive(
  target: Page | BrowserContext,
  options: {
    read?: (fileId: string) => string | undefined
    save?: (operationId: string, content: string) => void
  },
): Promise<void> {
  await target.route(/^https:\/\/www\.googleapis\.com\/(?:drive|upload\/drive)\/v3\/files[/?]/, async route => {
    const request = route.request()
    const url = new URL(request.url())
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
    if (request.method() === 'PUT' && options.save && url.pathname === '/upload/drive/v3/files') {
      options.save(url.searchParams.get('upload_id') ?? '', request.postData() ?? '')
      return route.fulfill({ status: 200, headers, json: {} })
    }
    if (request.method() === 'GET' && url.searchParams.get('alt') === 'media') {
      const body = options.read?.(decodeURIComponent(url.pathname.split('/').pop()!))
      if (body !== undefined) return route.fulfill({ body, headers, contentType: 'text/plain; charset=utf-8' })
    }
    return route.fulfill({ status: 404, headers })
  })
}
