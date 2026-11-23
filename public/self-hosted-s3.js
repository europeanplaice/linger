const about = document.getElementById('nav-about')
const app = document.getElementById('nav-app')
const buttons = document.querySelectorAll('[data-set-lang]')

function setLanguage(language) {
  const isJapanese = language === 'ja'
  document.documentElement.lang = language
  document.title = isJapanese
    ? '自分のAWS S3バケットへのバックアップ設定 — Linger'
    : 'Bring your own S3 bucket — Linger'
  about.textContent = isJapanese ? '← Lingerについて' : '← About'
  app.textContent = isJapanese ? 'アプリを開く' : 'Open app'

  for (const button of buttons) {
    button.classList.toggle('active', button.dataset.setLang === language)
  }
}

const queryLanguage = new URLSearchParams(window.location.search).get('lang')
const browserLanguage = navigator.language.toLowerCase().startsWith('ja') ? 'ja' : 'en'
setLanguage(queryLanguage === 'ja' || queryLanguage === 'en' ? queryLanguage : browserLanguage)

for (const button of buttons) {
  button.addEventListener('click', () => setLanguage(button.dataset.setLang))
}
