import { renderLanding } from '../../src/prerender'

test('renderLanding produces HTML with key marketing sections', () => {
  const html = renderLanding()
  expect(html).toContain('What is Linger?')
  expect(html).toContain('login-screen')
  expect(html).toContain('Features')
  expect(html).toContain('Data')
  expect(html).toContain('drive.file')
})

test('renderLanding output is non-empty and contains the landing wrapper', () => {
  const html = renderLanding()
  expect(html.length).toBeGreaterThan(1000)
  expect(html).toContain('<div class="landing">')
})
