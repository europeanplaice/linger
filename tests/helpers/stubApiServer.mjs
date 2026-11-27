import { createServer } from 'node:http'
import process from 'node:process'

const port = Number(process.env.PORT ?? 8788)

const server = createServer((req, res) => {
  const url = req.url ?? '/'
  res.setHeader('Content-Type', 'application/json')

  if (url === '/auth/session' || url.startsWith('/auth/session?')) {
    res.writeHead(200)
    res.end(JSON.stringify({ signedIn: false }))
    return
  }

  if (url.startsWith('/api/') || url.startsWith('/auth/')) {
    res.writeHead(401)
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return
  }

  res.writeHead(404)
  res.end(JSON.stringify({ error: 'Not found' }))
})

server.listen(port, '127.0.0.1')
