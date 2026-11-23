import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import ClipMentorPage from './pages/ClipMentorPage'

createRoot(document.getElementById('root')!).render(
  <StrictMode><ClipMentorPage /></StrictMode>,
)
