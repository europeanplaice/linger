import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { LoginScreen } from '../../src/components/LoginScreen'
import { I18nProvider } from '../../src/i18n'

describe('footer links', () => {
  it('opens each login footer link in a protected new tab', () => {
    const { container, unmount } = render(
      <I18nProvider initialLanguage="en"><LoginScreen onSignIn={() => {}} /></I18nProvider>,
    )
    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>('.login-footer a'))
    expect(links.map(link => link.getAttribute('href'))).toEqual(['/home', '/privacy', '/terms-of-service'])
    for (const link of links) {
      expect(link.target).toBe('_blank')
      expect(link.rel.split(' ')).toEqual(expect.arrayContaining(['noopener', 'noreferrer']))
    }
    unmount()
  })

  it.each([
    ['Linger', readFileSync('public/home.html', 'utf8'), ['/', '/privacy', '/terms-of-service']],
    ['Privacy Policy', readFileSync('public/privacy.html', 'utf8'), ['/home', '/']],
    ['Terms of Service', readFileSync('public/terms-of-service.html', 'utf8'), ['/home', '/']],
  ] as const)('contains heading %s and navigation links', (heading, html, destinations) => {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    expect(doc.querySelector('h1')?.textContent).toBe(heading)
    for (const destination of destinations) {
      expect(doc.querySelector(`a[href="${destination}"]`)).not.toBeNull()
    }
  })
})
