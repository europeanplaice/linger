import { LoginScreen } from './LoginScreen'

interface Props {
  onSignIn: () => void
  onRetry?: () => void
  tokenExpired?: boolean
  // Forwarded to LoginScreen so the build-time prerendered card is visible
  // before React mounts. See src/prerender.tsx.
  staticRender?: boolean
}

// The signed-out view at `/`. The hero is the existing sign-in card; the
// long-form marketing content below makes `/` the canonical, crawlable landing
// page (it is rendered into the initial HTML by the build-time prerender). The
// copy here is intentionally English — it is the canonical content for `/`.
export function Landing({ onSignIn, onRetry, tokenExpired, staticRender }: Props) {
  return (
    <div className="landing">
      <LoginScreen
        onSignIn={onSignIn}
        onRetry={onRetry}
        tokenExpired={tokenExpired}
        staticRender={staticRender}
      />

      <div className="landing-content">
        <section className="landing-shots" aria-label="Screenshots">
          <figure>
            <img
              src="/screenshots/editor.png"
              width={1280}
              height={820}
              loading="lazy"
              alt="Linger diary editor showing a dated entry alongside a monthly calendar in the sidebar"
            />
            <figcaption>Write your day. Browse past entries on the calendar.</figcaption>
          </figure>
          <figure>
            <img
              src="/screenshots/search.png"
              width={1280}
              height={820}
              loading="lazy"
              alt="Linger full-text search listing matching diary entries with highlighted keywords"
            />
            <figcaption>Full-text search across everything you've written.</figcaption>
          </figure>
          <div className="landing-shots-mobile">
            <figure>
              <img
                src="/screenshots/mobile-editor.png"
                width={390}
                height={844}
                loading="lazy"
                alt="Linger diary editor on a phone screen"
              />
            </figure>
            <figure>
              <img
                src="/screenshots/mobile-calendar.png"
                width={390}
                height={844}
                loading="lazy"
                alt="Linger calendar drawer open on a phone screen"
              />
            </figure>
          </div>
          <p className="landing-shots-caption">Works just as well on your phone.</p>
        </section>

        <section>
          <h2>What is Linger?</h2>
          <p>
            Linger is a personal diary web app. Write daily entries and access them from any
            device. Your entries are saved as individual plain-text files inside your own Google
            Drive account — you retain full ownership and control of your data at all times.
          </p>
          <p>
            To store and retrieve your diary files, Linger requests the Google Drive{' '}
            <code>drive.file</code> OAuth scope, along with the standard <code>openid</code> and{' '}
            <code>email</code> scopes used only to identify your account at sign-in. The{' '}
            <code>drive.file</code> scope grants access <strong>exclusively to files that Linger
            itself creates</strong> — it cannot read, modify, or delete any other files in your
            Google Drive.
          </p>
        </section>

        <section>
          <h2>Features</h2>
          <ul>
            <li>Write and edit diary entries with a clean, distraction-free editor</li>
            <li>Browse entries on a monthly calendar view</li>
            <li>Full-text search across all your entries</li>
            <li>View and restore previous versions of any entry</li>
            <li>Export all entries as a ZIP file</li>
            <li>Available in English and Japanese</li>
          </ul>
        </section>

        <section>
          <h2>Data &amp; Privacy</h2>
          <p>
            Diary entries reside entirely in your own Google Drive folder (
            <code>linger_diary/</code>). No diary content is stored on Linger's servers. OAuth
            tokens are handled server-side and are never exposed to the browser.
          </p>
          <p>
            For full details, see the <a href="/privacy">Privacy Policy</a>.
          </p>
        </section>

        <section>
          <h2>How to verify this app is safe</h2>
          <p>
            You don't have to take our word for it. Here are concrete steps you can take to verify
            that Linger cannot read, copy, or transmit your diary entries anywhere other than your
            own Google Drive.
          </p>
          <ol>
            <li>
              <strong>Check what Google permissions you granted</strong> — Go to{' '}
              <a
                href="https://myaccount.google.com/permissions"
                target="_blank"
                rel="noopener noreferrer"
              >
                Google Account → Apps &amp; services
              </a>{' '}
              and find Linger. The only scope listed should be the <code>drive.file</code> scope,
              which cannot access any other files in your Drive. You can revoke access there at any
              time.
            </li>
            <li>
              <strong>Inspect network requests in your browser</strong> — Open DevTools → Network
              while using the app. Every request goes to <code>/api/drive/…</code> (the Cloudflare
              proxy on this domain) or <code>accounts.google.com</code> (OAuth). No requests are
              made to any third-party server.
            </li>
            <li>
              <strong>Read the source code</strong> — The entire codebase is open source on{' '}
              <a
                href="https://github.com/europeanplaice/linger"
                target="_blank"
                rel="noopener noreferrer"
              >
                GitHub
              </a>
              . You can also self-host using your own Google Cloud and Cloudflare accounts.
            </li>
          </ol>
        </section>

        <footer className="landing-footer">
          <a href="/privacy">Privacy Policy</a>
          {' · '}
          <a href="/terms-of-service">Terms of Service</a>
          {' · '}
          <a href="https://github.com/europeanplaice/linger" target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
        </footer>
      </div>
    </div>
  )
}
