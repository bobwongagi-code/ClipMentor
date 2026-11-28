import type { Locator, Page } from '@playwright/test'

type Surface = Page | Locator
export async function acknowledgeOverallFeedback(surface:Surface){
  await surface.getByLabel('意见针对哪里').selectOption('whole')
  await surface.getByLabel('这条意见针对整支视频').check()
}

export async function checkFinalReview(surface:Surface){
  await surface.getByLabel('我已看过成片',{exact:true}).check()
  await surface.getByLabel('我已核对口播和字幕',{exact:true}).check()
}

export const approvedFixtureReview = {
  canApproveBlueprint:true,
  reviewGroups:[{id:'fixture-group',label:'第 1 组'}],
}
