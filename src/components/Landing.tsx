import type { ReactNode } from 'react'
import { useI18n } from '../i18n'
import { LoginScreen } from './LoginScreen'
import { DeploymentVerification } from './DeploymentVerification'
import type { AuthErrorCode, GoogleConnection } from '../hooks/useAuth'

interface Props {
  passkeyGate?: ReactNode
  onSignIn: () => void
  onLockVault?: () => void
  onUseAnotherAccount?: () => void
  onRetry?: () => void
  tokenExpired?: boolean
  authResolved?: boolean
  authError?: AuthErrorCode | null
  onDismissAuthError?: () => void
  googleConnection?: GoogleConnection
  onRetryConnection?: () => void
  signingIn?: boolean
  email?: string | null
  rememberDevicePrompt?: ReactNode
}

// The signed-out view at `/`. The hero is the existing sign-in card; the
// long-form marketing content below makes `/` the canonical, crawlable landing
// page (it is rendered into the initial HTML by the build-time prerender). The
// copy here is intentionally English — it is the canonical content for `/`.
export function Landing({ passkeyGate, onLockVault, onSignIn, onUseAnotherAccount, onRetry, tokenExpired, authResolved, authError, onDismissAuthError, googleConnection, onRetryConnection, signingIn, email, rememberDevicePrompt }: Props) {
  const { t } = useI18n()
  const l = t.landing

  return (
    <div className="landing">
      {passkeyGate ?? <LoginScreen
        onSignIn={onSignIn}
        onLockVault={onLockVault}
        onUseAnotherAccount={onUseAnotherAccount}
        onRetry={onRetry}
        tokenExpired={tokenExpired}
        authResolved={authResolved}
        authError={authError}
        onDismissAuthError={onDismissAuthError}
        googleConnection={googleConnection}
        onRetryConnection={onRetryConnection}
        signingIn={signingIn}
        email={email}
      />}
      {rememberDevicePrompt}

      <div className="landing-content">
        <section className="landing-shots" id="screenshots" aria-label={l.shotsAriaLabel}>
          <figure>
            <img
              src="/screenshots/editor.png"
              width={1280}
              height={820}
              loading="lazy"
              alt="Linger diary editor showing a dated entry alongside a monthly calendar in the sidebar"
            />
            <figcaption>{l.shotEditorCaption}</figcaption>
          </figure>
          <figure>
            <img
              src="/screenshots/search.png"
              width={1280}
              height={820}
              loading="lazy"
              alt="Linger full-text search listing matching diary entries with highlighted keywords"
            />
            <figcaption>{l.shotSearchCaption}</figcaption>
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
          <p className="landing-shots-caption">{l.shotMobileCaption}</p>
        </section>

        <section id="about">
          <h2>{l.whatIsTitle}</h2>
          <p>{l.whatIsBody1}</p>
          <p>
            {l.whatIsBody2ScopePrefix}
            <code>drive.file</code>
            {l.whatIsBody2ScopeMid1}
            <code>openid</code>
            {l.whatIsBody2ScopeMid2}
            <code>email</code>
            {l.whatIsBody2ScopeMid3}
            <code>drive.file</code>
            {l.whatIsBody2ScopeMid4}
            <strong>{l.whatIsBody2ScopeStrong}</strong>
            {l.whatIsBody2ScopeSuffix}
          </p>
        </section>

        <section>
          <h2>{l.featuresTitle}</h2>
          <ul>
            {l.features.map(feature => (
              <li key={feature}>{feature}</li>
            ))}
          </ul>
        </section>

        <section>
          <h2>{l.privacyTitle}</h2>
          <p>{l.privacySummary}</p>
          <details className="landing-tech-details">
            <summary>{l.privacyTechSummary}</summary>
            <p>
              {l.privacyTechBody1Prefix}
              <code>linger_diary/</code>
              {l.privacyTechBody1Suffix}
            </p>
          </details>
          <p>
            {l.privacyPolicyPrefix}
            <a href="/privacy">{l.privacyPolicyLink}</a>
            {l.privacyPolicySuffix}
          </p>
        </section>

        <section>
          <h2>{l.verifyTitle}</h2>
          <p>{l.verifyIntro}</p>
          <ol>
            <li>
              <strong>{l.verifyStep1Title}</strong> — {l.verifyStep1Before}
              <a
                href="https://myaccount.google.com/permissions"
                target="_blank"
                rel="noopener noreferrer"
              >
                {l.verifyStep1Link}
              </a>
              {l.verifyStep1Mid}
              <code>drive.file</code>
              {l.verifyStep1After}
            </li>
            <li>
              <strong>{l.verifyStep2Title}</strong> — {l.verifyStep2Part1}
              <code>/api/drive/…</code>
              {l.verifyStep2Part2}
              <code>accounts.google.com</code>
              {l.verifyStep2Part3}
              <code>api.github.com</code>
              {l.verifyStep2Part4}
            </li>
            <li>
              <strong>{l.verifyStep3Title}</strong> — {l.verifyStep3Before}
              <a
                href="https://github.com/europeanplaice/linger"
                target="_blank"
                rel="noopener noreferrer"
              >
                {l.verifyStep3Link}
              </a>
              {l.verifyStep3After}
            </li>
          </ol>
        </section>

        <section className="landing-cta">
          <h2>{l.ctaTitle}</h2>
          <p>{l.ctaDescription}</p>
          <a className="landing-cta-btn" href="#top">{l.ctaButton}</a>
        </section>

        <footer className="landing-footer">
          <DeploymentVerification />
          <a href="/privacy">{t.login.privacyPolicy}</a>
          {' · '}
          <a href="/terms-of-service">{t.login.termsOfService}</a>
          {' · '}
          <a href="https://github.com/europeanplaice/linger" target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
        </footer>
      </div>
    </div>
  )
}
