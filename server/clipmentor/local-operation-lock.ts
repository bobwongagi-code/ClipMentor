import {randomUUID} from 'node:crypto';
import {link, rm} from 'node:fs/promises';
import {dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {atomicWriteFile,syncDirectory} from '../plugins/project-store-durable';

/** SQLite releases this write lock when a process dies. Keep the database inode. */
export function tryLocalOperationLock(path:string):(()=>void)|undefined {
  const db=new DatabaseSync(path+'.sqlite');
  try {
    db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
  } catch(error) {
    db.close();
    if((error as {errcode?:number}).errcode===5||String(error).includes('database is locked'))return;
    throw error;
  }
  return ()=>db.close();
}

/** Publish complete preparation identity without replacing a legacy writer's claim. */
export async function publishOperationPreparation(path:string,row:Record<string,unknown>) {
  const stage=`${path}.${randomUUID()}.preparation`;
  try {
    await atomicWriteFile(stage,JSON.stringify({...row,preparation_protocol:1,status:'preparing',requests_attempted:0}));
    await link(stage,path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(stage,{force:true});
  }
}

export function isResumablePreparation(row:Record<string,unknown>) {
  return row.preparation_protocol===1&&row.status==='preparing'&&row.requests_attempted===0;
}
