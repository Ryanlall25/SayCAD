import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import CrownStudio from './studio/CrownStudio'
import './app.css'

/** Hash routes: #/ → Crown Studio (the lab's crown department), #/sandbox → the
 *  original talk-to-CAD sandbox. */
function Root(): React.JSX.Element {
  const [route, setRoute] = useState(location.hash)
  useEffect(() => {
    const on = (): void => setRoute(location.hash)
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route.startsWith('#/sandbox') ? <App /> : <CrownStudio />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>
)

if ('serviceWorker' in navigator && import.meta.env.PROD && window.top === window && location.protocol === 'https:') {
  window.addEventListener('load', () => void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined))
}
