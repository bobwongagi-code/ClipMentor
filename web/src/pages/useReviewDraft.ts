import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/** Write in the input event so refresh and navigation do not race a React effect. */
export function useReviewDraft<T extends {key:string}>(projectId:string|undefined, scope:string, subject:string|undefined, valid:(draft:T)=>boolean) {
  const prefix=projectId ? `clipmentor:review:${projectId}:${scope}` : undefined
  const storageKey=prefix&&subject ? `${prefix}:${subject}` : undefined

  const read=useCallback((fallback?:T)=>{
    if (!storageKey || !prefix) return fallback
    try {
      const raw=localStorage.getItem(storageKey)??localStorage.getItem(prefix)
      const value=JSON.parse(raw??'null')
      return value?.key===subject&&valid(value) ? value as T : undefined
    } catch { return fallback }
  },[storageKey,prefix,subject,valid])

  const initial=useMemo(()=>read(),[read])
  const [edited,setEdited]=useState<{id:string|undefined;value:T|undefined;localOnly?:boolean}>()
  const [externalEdit,setExternalEdit]=useState<{id:string;value:T|undefined}>()
  const activeEdit=edited?.id===storageKey?edited:undefined
  const value=activeEdit?activeEdit.value:initial
  const current=useRef({id:storageKey,value,localOnly:false})
  if(current.current.id!==storageKey)current.current={id:storageKey,value,localOnly:false}

  const readCurrent=useCallback(()=>{
    const entry=current.current
    return entry.id===storageKey&&entry.localOnly ? entry.value : read(entry.id===storageKey?entry.value:undefined)
  },[storageKey,read])

  useEffect(()=>{
    if(!storageKey)return
    const refresh=(event:StorageEvent)=>{
      if(current.current.id!==storageKey||current.current.localOnly||event.key!==storageKey&&event.key!==prefix&&event.key!==null)return
      const value=read()
      current.current={id:storageKey,value,localOnly:false}
      setEdited({id:storageKey,value})
      setExternalEdit({id:storageKey,value})
    }
    window.addEventListener('storage',refresh)
    // Catch a write from another tab between render and listener registration.
    if(!current.current.localOnly){
      const value=read()
      current.current={id:storageKey,value,localOnly:false}
      setEdited({id:storageKey,value})
    }
    return ()=>window.removeEventListener('storage',refresh)
  },[storageKey,prefix,read])

  const setDraft=useCallback((next:T|undefined|((previous:T|undefined)=>T|undefined))=>{
    if(current.current.id!==storageKey)return
    const prior=readCurrent()
    const value=typeof next==='function' ? next(prior) : next
    if(value===prior)return
    let localOnly=!storageKey
    try {
      if(storageKey&&prefix){
        if(value===undefined)localStorage.removeItem(storageKey)
        else localStorage.setItem(storageKey,JSON.stringify(value))
        // Move only the matching legacy draft. Another revision might have its own.
        if(JSON.parse(localStorage.getItem(prefix)??'null')?.key===subject)localStorage.removeItem(prefix)
      }
    } catch { localOnly=true }
    current.current={id:storageKey,value,localOnly}
    setEdited({id:storageKey,value,localOnly})
  },[storageKey,prefix,subject,readCurrent])
  return [value,setDraft,readCurrent,activeEdit?.localOnly===true,externalEdit?.id===storageKey?externalEdit:undefined] as const
}
