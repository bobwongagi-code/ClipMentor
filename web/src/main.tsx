import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import ClipMentorPage from './pages/ClipMentorPage'
import TaskWorkspace from './pages/TaskWorkspace'

createRoot(document.getElementById('root')!).render(
  <StrictMode>{__CLIPMENTOR_WORKSPACE__&&new URLSearchParams(window.location.search).get('demo')!=='1'?<TaskWorkspace/>:<ClipMentorPage/>}</StrictMode>,
)
