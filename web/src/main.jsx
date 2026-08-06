import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import FlowAnalysis from './FlowAnalysis.jsx'
import './styles.css'

const query = new URLSearchParams(window.location.search)

if (query.get('desktop') === 'orb') {
  document.documentElement.dataset.desktop = 'orb'
}

// The analysis page replaces the app rather than living inside it: it exists to
// study interactions that already happened, and mounting the voice client
// alongside would start a new one.
const Root = query.get('analysis') === 'flow' ? FlowAnalysis : App

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
