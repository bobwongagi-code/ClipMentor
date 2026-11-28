export const workspaceEndpoint = `${__CLIPMENTOR_API_BASE_PATH__}/tasks`

export function projectResource(url: string, projectId?: string) {
  if (!projectId) return url
  const [path, query] = url.split('?', 2)
  const params = new URLSearchParams(query)
  params.set('projectId', projectId)
  return `${path}?${params}`
}

export type TaskView = 'materials' | 'blueprint' | 'film'

export function taskPage(id?: string, view?: 'new' | TaskView, audience?: 'new_contact' | 'existing_partner') {
  const query = new URLSearchParams()
  if (id) query.set('task', id)
  if (view) query.set('view', view)
  if (audience) query.set('audience',audience)
  return query.size ? `?${query}` : window.location.pathname
}
