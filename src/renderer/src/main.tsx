import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
// Imported for its side effects as well as the hook: it sets <html lang>, which
// styles.css keys the font stack off. Importing it HERE (not only from whichever
// components happen to use t()) guarantees every window gets it — panel and menu
// windows aren't translated yet and would otherwise render in the wrong font.
import './useT'
import './frost' // side effect: drive the acrylic scrim from the frostStrength setting
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

// Tell main the UI is really up. `did-finish-load` is NOT enough: it fires for the
// document, and a window whose module scripts failed (Vite's cold-start dependency
// re-optimisation answers them with 504s) reports a perfectly successful load while
// React never mounted — which is exactly how the OSC came up as a bare frosted pane
// with its strip reserved and nothing in it. Main waits for this ping and reloads the
// window if it never arrives; getting here means the whole import chain executed.
window.mmp?.rendererReady?.()
