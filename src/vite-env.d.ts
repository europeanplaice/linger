/// <reference types="vite/client" />

declare const __DEPLOY_VERSION__: string

declare namespace React {
  namespace JSX {
    interface IntrinsicElements {
      'relative-time': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        datetime?: string
        format?: 'relative' | 'duration' | 'datetime' | 'auto'
        tense?: 'past' | 'future' | 'auto'
        precision?: 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second'
      }
    }
  }
}
